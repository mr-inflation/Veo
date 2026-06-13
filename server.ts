import express from "express";
import path from "path";
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

// Load environment variables for local testing if needed
dotenv.config();

const app = express();
const PORT = 3000;

// Increase payload client-side size limits so users can upload larger seed image frames
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Helper to get GoogleGenAI client lazily to avoid crashing on boot if key is not yet set
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY environment variable is not configured yet. Please configure it in the Secrets panel.");
  }
  return {
    ai: new GoogleGenAI({ apiKey }),
    apiKey,
  };
}

// Check environment health
app.get("/api/health", (req, res) => {
  const hasKey = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  res.json({
    status: "ok",
    apiKeyConfigured: !!hasKey,
  });
});

// 1. Generate Video Endpoint
app.post("/api/generate-video", async (req, res) => {
  try {
    const { ai } = getGeminiClient();
    const {
      prompt,
      aspectRatio = "16:9",
      resolution = "720p",
      model = "veo-3.1-lite-generate-preview",
      firstFrame, // base64 string
      lastFrame,  // base64 string
      referenceImages, // Array of base64 images { data, mimeType, type: 'ASSET' | ... }
      videoExtending, // optional video block from previous generation
    } = req.body;

    if (!prompt && !firstFrame && !videoExtending) {
      return res.status(400).json({ error: "Either a prompt, frame, or source video is required to generate a video." });
    }

    // Build the payload
    const requestPayload: any = {
      model,
      config: {
        numberOfVideos: 1,
        resolution,
        aspectRatio,
      },
    };

    // Prompt is optional if we extend or seed images, but generally provided or fallback to empty string
    if (prompt) {
      requestPayload.prompt = prompt;
    }

    // Handle standard single seed image (first frame)
    if (firstFrame) {
      const cleanedSeed = firstFrame.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
      requestPayload.image = {
        imageBytes: cleanedSeed,
        mimeType: "image/png",
      };
    }

    // Handle last frame image
    if (lastFrame) {
      const cleanedLast = lastFrame.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
      requestPayload.config.lastFrame = {
        imageBytes: cleanedLast,
        mimeType: "image/png",
      };
    }

    // Handle multiple reference images (up to 3)
    if (Array.isArray(referenceImages) && referenceImages.length > 0) {
      const referenceImagesPayload = referenceImages.map((img: any) => {
        const cleanedData = img.data.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
        return {
          image: {
            imageBytes: cleanedData,
            mimeType: img.mimeType || "image/png",
          },
          referenceType: img.type || "ASSET",
        };
      });
      requestPayload.config.referenceImages = referenceImagesPayload;
    }

    // Handle video extension (only for 720p on veo-3.1-generate-preview)
    if (videoExtending) {
      if (videoExtending.operationName) {
        console.log(`[Veo Video Studio] Resolving parent video from operation: ${videoExtending.operationName}`);
        try {
          const op = new GenerateVideosOperation();
          op.name = videoExtending.operationName;
          const parentOp = await ai.operations.getVideosOperation({ operation: op });
          const parentVideo = parentOp.response?.generatedVideos?.[0]?.video;
          if (parentVideo) {
            requestPayload.video = parentVideo;
            console.log(`[Veo Video Studio] Successfully matched parent video:`, parentVideo);
          } else {
            console.warn(`[Veo Video Studio] Parent operation response did not contain a video. Falling back to inline payload.`);
            requestPayload.video = videoExtending;
          }
        } catch (opErr) {
          console.error(`[Veo Video Studio] Failed to query parent operation for extension, falling back:`, opErr);
          requestPayload.video = videoExtending;
        }
      } else {
        requestPayload.video = videoExtending;
      }
    }

    console.log(`[Veo Video Studio] Dispatching generateVideos API request for model: ${model}`);
    const operation = await ai.models.generateVideos(requestPayload);

    console.log(`[Veo Video Studio] Created generation operation: ${operation.name}`);
    res.json({
      operationName: operation.name,
      model,
      aspectRatio,
      resolution,
      prompt,
    });
  } catch (error: any) {
    console.error("[Veo Video Studio] Generation error:", error);
    const errString = error.message || String(error);
    if (errString.includes("429") || errString.includes("quota") || errString.includes("RESOURCE_EXHAUSTED")) {
      return res.status(429).json({
        error: "QUOTA_EXHAUSTED",
        message: "You exceeded your current Google API quota for video generation. For premium models like Veo 3.1, video creation has tight quota thresholds. Try again after some minutes, or toggle into Cinematic Sandbox Simulation mode."
      });
    }
    res.status(500).json({ error: errString || "Failed to start video generation" });
  }
});

// 2. Poll Video Operation Status Endpoint
app.post("/api/video-status", async (req, res) => {
  try {
    const { ai } = getGeminiClient();
    const { operationName } = req.body;

    if (!operationName) {
      return res.status(400).json({ error: "operationName is required" });
    }

    console.log(`[Veo Video Studio] Polling status for operation: ${operationName}`);
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });

    res.json({
      done: !!updated.done,
      error: updated.error ? updated.error.message : null,
      status: updated.done ? "completed" : "processing",
    });
  } catch (error: any) {
    console.error("[Veo Video Studio] Polling error:", error);
    const errString = error.message || String(error);
    if (errString.includes("429") || errString.includes("quota") || errString.includes("RESOURCE_EXHAUSTED")) {
      return res.status(429).json({
        error: "QUOTA_EXHAUSTED",
        message: "Google API rate limit has been hit during video check status. Please try checking in a short moment."
      });
    }
    res.status(500).json({ error: errString || "Failed to get video status" });
  }
});

// 3. Download / Stream Video Segment Endpoint
app.all("/api/video-download", async (req, res) => {
  try {
    const { ai, apiKey } = getGeminiClient();
    const operationName = (req.query.operationName as string) || req.body?.operationName;

    if (!operationName) {
      return res.status(400).json({ error: "operationName is required" });
    }

    console.log(`[Veo Video Studio] Downloading completed operation: ${operationName}`);
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });

    if (!updated.done) {
      return res.status(400).json({ error: "Operation is not yet complete. Please poll/wait." });
    }

    const generatedVideo = updated.response?.generatedVideos?.[0]?.video;
    const uri = generatedVideo?.uri;

    if (!uri) {
      return res.status(404).json({ error: "No video generated or URI not found in completed operation." });
    }

    console.log(`[Veo Video Studio] Streaming content from temporary storage URL: ${uri}`);

    const videoRes = await fetch(uri, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!videoRes.ok) {
      throw new Error(`Failed to ingest video from Google endpoint: ${videoRes.statusText}`);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=31536000");

    // Capture the body stream and pipe it back to Express response safely
    if (videoRes.body) {
      const reader = videoRes.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(value);
        await pump();
      };
      await pump();
    } else {
      res.status(500).json({ error: "Video stream body is empty" });
    }
  } catch (error: any) {
    console.error("[Veo Video Studio] Download error:", error);
    res.status(500).json({ error: error.message || "Failed to proxy download file" });
  }
});

// Bootstrap full-stack pipeline (Vite vs. Static serving)
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development Mode: Inject Vite as middleware
    console.log("[Veo Video Studio] Initializing Vite development server middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode: Serve built files from /dist
    console.log("[Veo Video Studio] Booting in production static mode...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Veo Video Studio] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[Veo Video Studio] Boot configuration crash:", err);
});