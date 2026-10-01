import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import {
  formatCostTag,
  roundMilliseconds,
  errorMessage,
} from "@rodrigo-barraza/utilities-library";
import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import { getProvider } from "#src/providers/index";
import { SOUND_EFFECT_MODEL } from "#src/providers/elevenlabs";
import { ProviderError } from "#src/utils/errors";
import { getModelByName } from "#src/config";
import { calculateAudioCost } from "#src/utils/CostCalculator";
import logger from "#src/utils/logger";
import RequestLogger from "#src/services/RequestLogger";
import { PROVIDERS } from "#src/constants";

const router = express.Router();

/** ElevenLabs' bounds on a clip's length, in seconds. */
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 30;
/** mp3_44100_128 is 128 kbit/s: a clip's byte count over this is its length. */
const MP3_BYTES_PER_SECOND = 128_000 / 8;

/**
 * POST /text-to-sound-effect
 * Body: { prompt, durationSeconds?, loop?, promptInfluence?, provider?, model?, traceId? }
 *
 * Default:          Binary audio with its content-type header
 * ?format=dataUrl:  JSON { audioDataUrl, contentType, durationSeconds }
 *
 * Billed per generated second, so the cost is logged from the requested
 * duration, or — when the model picked the length — from the MP3's size.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const {
      prompt,
      durationSeconds,
      loop,
      promptInfluence,
      provider: providerName = PROVIDERS.ELEVENLABS,
      model,
      traceId,
    } = req.body ?? {};
    const modelName =
      model ||
      (providerName === PROVIDERS.ELEVENLABS ? SOUND_EFFECT_MODEL : null);

    try {
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw new ProviderError("server", "Missing required field: prompt", 400);
      }
      if (
        durationSeconds !== undefined &&
        (typeof durationSeconds !== "number" ||
          durationSeconds < MIN_DURATION_SECONDS ||
          durationSeconds > MAX_DURATION_SECONDS)
      ) {
        throw new ProviderError(
          "server",
          `durationSeconds must be a number from ${MIN_DURATION_SECONDS} to ${MAX_DURATION_SECONDS}`,
          400,
        );
      }

      const provider = getProvider(providerName);
      if (!provider.generateSoundEffect) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support sound effects`,
          400,
        );
      }

      const result = await provider.generateSoundEffect(prompt.trim(), {
        model,
        durationSeconds,
        loop: typeof loop === "boolean" ? loop : undefined,
        promptInfluence:
          typeof promptInfluence === "number" ? promptInfluence : undefined,
      });

      const totalSec = (performance.now() - requestStart) / 1000;
      const generatedSeconds =
        durationSeconds ?? result.audio.length / MP3_BYTES_PER_SECOND;
      const modelDefinition = modelName
        ? (getModelByName(modelName) as { pricing?: Record<string, number> } | null)
        : null;
      const estimatedCost = calculateAudioCost(
        { inputTokens: 0, outputTokens: 0, durationSeconds: generatedSeconds },
        modelDefinition?.pricing ?? null,
      );

      logger.request(
        req.project || "any",
        req.username || "any",
        req.clientIp || null,
        `[sound-effect] ${providerName} model=${modelName || "default"} — ` +
          `${generatedSeconds.toFixed(1)}s of audio, total: ${totalSec.toFixed(2)}s${formatCostTag(estimatedCost)}`,
      );
      RequestLogger.log({
        requestId,
        endpoint: "text-to-sound-effect",
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
        provider: providerName,
        model: modelName,
        traceId: traceId || null,
        success: true,
        inputCharacters: prompt.length,
        estimatedCost,
        totalTime: roundMilliseconds(totalSec),
      });

      if (req.query.format === "dataUrl") {
        return res.json({
          audioDataUrl: `data:${result.contentType};base64,${result.audio.toString("base64")}`,
          contentType: result.contentType,
          durationSeconds: Math.round(generatedSeconds * 10) / 10,
        });
      }
      res.setHeader("Content-Type", result.contentType);
      res.send(result.audio);
    } catch (error: unknown) {
      const totalSec = (performance.now() - requestStart) / 1000;
      RequestLogger.log({
        requestId,
        endpoint: "text-to-sound-effect",
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
        provider: providerName,
        model: modelName,
        traceId: traceId || null,
        success: false,
        errorMessage: errorMessage(error),
        totalTime: totalSec,
      });
      next(error);
    }
  }),
);

export default router;
