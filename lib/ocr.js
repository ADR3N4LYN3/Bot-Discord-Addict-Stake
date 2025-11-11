// lib/ocr.js
import { createWorker } from 'tesseract.js';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const debug = process.env.DEBUG_TELEGRAM === '1';

// Cache pour éviter de traiter plusieurs fois la même image
const processedCache = new Set();
const CACHE_TTL = 60 * 60 * 1000; // 1 heure

// Initialiser le worker Tesseract (réutilisé pour toutes les images)
let ocrWorker = null;

/**
 * Initialise le worker OCR Tesseract
 */
export async function initOCR() {
  if (ocrWorker) return ocrWorker;

  console.log('[ocr] Initializing Tesseract worker...');
  ocrWorker = await createWorker('eng', 1, {
    logger: debug ? (m) => console.log('[ocr]', m) : undefined,
  });

  // Configuration optimale pour détecter des codes courts
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: '6', // Assume uniform block of text
    tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  });

  console.log('[ocr] Tesseract worker ready');
  return ocrWorker;
}

/**
 * Extrait le code bonus d'un texte OCR
 * Pattern: stakecomXXXXXXXX (10-30 caractères alphanumériques)
 */
function extractBonusCodeFromText(text) {
  if (!text) return null;

  // Pattern prioritaire: stakecom suivi de caractères alphanumériques
  const stakecomPattern = /stakecom[a-z0-9]{3,20}/gi;
  const stakecomMatches = text.match(stakecomPattern);

  if (stakecomMatches && stakecomMatches.length > 0) {
    const code = stakecomMatches[0].toLowerCase();
    if (debug) console.log('[ocr] Found stakecom code:', code);
    return code;
  }

  // Pattern générique: code alphanumérique de 10-30 caractères
  const genericPattern = /\b[a-z0-9]{10,30}\b/gi;
  const genericMatches = text.match(genericPattern);

  if (genericMatches && genericMatches.length > 0) {
    const code = genericMatches[0].toLowerCase();
    if (debug) console.log('[ocr] Found generic code:', code);
    return code;
  }

  return null;
}

/**
 * Preprocess une image pour améliorer la détection OCR
 * - Crop le tiers inférieur de l'image (zone du code)
 * - Augmente le contraste et la netteté
 * - Convertit en niveaux de gris
 * @param {string} imagePath - Chemin vers l'image originale
 * @returns {Promise<string>} - Chemin vers l'image preprocessée
 */
async function preprocessImage(imagePath) {
  try {
    const preprocessedPath = imagePath.replace(/\.(jpg|png|jpeg)$/i, '_preprocessed.png');

    // Obtenir les dimensions de l'image
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Calculer la zone à extraire (tiers inférieur centré)
    const cropHeight = Math.floor(height / 3);
    const cropTop = height - cropHeight;

    if (debug) {
      console.log('[ocr] Preprocessing image:', imagePath);
      console.log('[ocr] Original size:', width, 'x', height);
      console.log('[ocr] Cropping bottom third: top=', cropTop, 'height=', cropHeight);
    }

    // Crop + amélioration + niveaux de gris
    await sharp(imagePath)
      .extract({ left: 0, top: cropTop, width, height: cropHeight })
      .greyscale()
      .normalize() // Améliore le contraste automatiquement
      .sharpen()
      .toFile(preprocessedPath);

    if (debug) console.log('[ocr] Preprocessed image saved:', preprocessedPath);

    return preprocessedPath;
  } catch (error) {
    console.error('[ocr] Preprocessing error:', error.message);
    // En cas d'erreur, retourner l'image originale
    return imagePath;
  }
}

/**
 * Extrait le code bonus depuis une image
 * @param {string} imagePath - Chemin vers l'image
 * @returns {Promise<{code: string|null, text: string, confidence: number}>}
 */
export async function extractCodeFromImage(imagePath) {
  let preprocessedPath = null;

  try {
    if (!ocrWorker) {
      await initOCR();
    }

    if (debug) console.log('[ocr] Processing image:', imagePath);

    // Preprocessing: crop la zone du code + amélioration
    preprocessedPath = await preprocessImage(imagePath);

    // OCR sur l'image preprocessée
    const { data } = await ocrWorker.recognize(preprocessedPath);
    const extractedText = data.text;
    const bonusCode = extractBonusCodeFromText(extractedText);

    if (debug) {
      console.log('[ocr] Extracted text:', extractedText.substring(0, 200));
      console.log('[ocr] Confidence:', data.confidence);
      console.log('[ocr] Bonus code found:', bonusCode || 'none');
    }

    // Nettoyer l'image preprocessée
    if (preprocessedPath !== imagePath) {
      cleanupFile(preprocessedPath);
    }

    return {
      code: bonusCode,
      text: extractedText,
      confidence: data.confidence,
    };
  } catch (error) {
    console.error('[ocr] Image processing error:', error.message);

    // Nettoyer l'image preprocessée en cas d'erreur
    if (preprocessedPath && preprocessedPath !== imagePath) {
      cleanupFile(preprocessedPath);
    }

    return { code: null, text: '', confidence: 0 };
  }
}

/**
 * Extrait les frames des dernières secondes d'une vidéo
 * @param {string} videoPath - Chemin vers la vidéo
 * @param {number} lastSeconds - Nombre de secondes à extraire depuis la fin (défaut: 2)
 * @param {number} fps - Nombre de frames par seconde à extraire (défaut: 5)
 * @returns {Promise<string[]>} - Tableau des chemins des frames extraites (ordre inverse: plus récentes en premier)
 */
function extractVideoFrames(videoPath, lastSeconds = 2, fps = 5) {
  return new Promise((resolve, reject) => {
    const frameDir = path.join('/tmp', `frames_${Date.now()}`);

    if (!fs.existsSync(frameDir)) {
      fs.mkdirSync(frameDir, { recursive: true });
    }

    if (debug) console.log('[ocr] Extracting last', lastSeconds, 'seconds of video at', fps, 'fps');

    // D'abord obtenir la durée de la vidéo
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error('[ocr] FFprobe error:', err.message);
        reject(err);
        return;
      }

      const duration = metadata.format.duration;
      const startTime = Math.max(0, duration - lastSeconds);

      if (debug) console.log('[ocr] Video duration:', duration, 's, extracting from', startTime.toFixed(1), 's');

      // Extraire seulement les dernières secondes
      ffmpeg(videoPath)
        .seekInput(startTime)
        .duration(lastSeconds)
        .outputOptions([
          `-vf fps=${fps}`,
        ])
        .output(path.join(frameDir, 'frame-%03d.png'))
        .on('end', () => {
          const frames = fs.readdirSync(frameDir)
            .filter(f => f.startsWith('frame-'))
            .map(f => path.join(frameDir, f))
            .sort()
            .reverse(); // Ordre inverse: dernières frames en premier

          if (debug) console.log('[ocr] Extracted', frames.length, 'frames (reversed order)');
          resolve(frames);
        })
        .on('error', (err) => {
          console.error('[ocr] FFmpeg error:', err.message);
          reject(err);
        })
        .run();
    });
  });
}

/**
 * Extrait le code bonus depuis une vidéo
 * @param {string} videoPath - Chemin vers la vidéo
 * @returns {Promise<{code: string|null, text: string, confidence: number, framesProcessed: number}>}
 */
export async function extractCodeFromVideo(videoPath) {
  let frames = [];
  let frameDir = null;

  try {
    if (!ocrWorker) {
      await initOCR();
    }

    if (debug) console.log('[ocr] Processing video:', videoPath);

    // Extraire 2 frames par seconde (compromis vitesse/précision)
    frames = await extractVideoFrames(videoPath, 2);
    frameDir = path.dirname(frames[0]);

    // Traiter chaque frame jusqu'à trouver un code
    for (const framePath of frames) {
      const result = await extractCodeFromImage(framePath);

      if (result.code) {
        if (debug) console.log('[ocr] Code found in frame:', framePath);

        // Nettoyer les frames
        cleanupDirectory(frameDir);

        return {
          code: result.code,
          text: result.text,
          confidence: result.confidence,
          framesProcessed: frames.indexOf(framePath) + 1,
        };
      }
    }

    // Aucun code trouvé
    if (debug) console.log('[ocr] No code found in', frames.length, 'frames');
    cleanupDirectory(frameDir);

    return {
      code: null,
      text: '',
      confidence: 0,
      framesProcessed: frames.length,
    };
  } catch (error) {
    console.error('[ocr] Video processing error:', error.message);

    // Nettoyer en cas d'erreur
    if (frameDir) cleanupDirectory(frameDir);

    return {
      code: null,
      text: '',
      confidence: 0,
      framesProcessed: 0,
    };
  }
}

/**
 * Nettoie un répertoire et tous ses fichiers
 */
function cleanupDirectory(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        fs.unlinkSync(path.join(dirPath, file));
      }
      fs.rmdirSync(dirPath);
      if (debug) console.log('[ocr] Cleaned up directory:', dirPath);
    }
  } catch (error) {
    console.error('[ocr] Cleanup error:', error.message);
  }
}

/**
 * Nettoie un fichier
 */
export function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      if (debug) console.log('[ocr] Cleaned up file:', filePath);
    }
  } catch (error) {
    console.error('[ocr] File cleanup error:', error.message);
  }
}

/**
 * Vérifie si une image a déjà été traitée récemment (cache)
 */
export function isAlreadyProcessed(messageId) {
  return processedCache.has(messageId);
}

/**
 * Marque une image comme traitée
 */
export function markAsProcessed(messageId) {
  processedCache.add(messageId);

  // Nettoyer le cache après TTL
  setTimeout(() => {
    processedCache.delete(messageId);
  }, CACHE_TTL);
}

/**
 * Termine le worker OCR (à appeler lors de l'arrêt du bot)
 */
export async function terminateOCR() {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
    console.log('[ocr] Tesseract worker terminated');
  }
}
