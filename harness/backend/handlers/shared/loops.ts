import type { Context } from "hono";
import type { ConfigContext } from "../../middleware/config.ts";
import { loopController } from "../../services/loopController.ts";
import type { CreateLoopRequest, UpdateLoopRequest } from "../../../shared/types.ts";

export async function handleCreateLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const body = await c.req.json<CreateLoopRequest>();
  if (!body.sessionId || !body.name || !body.prompt || !body.strategy) {
    return c.json(
      { error: "sessionId, name, prompt, and strategy are required" },
      400,
    );
  }
  try {
    const loop = await loopController.create(body);
    return c.json(loop, 201);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

export async function handleListLoops(
  c: Context<ConfigContext>,
): Promise<Response> {
  const sessionId = c.req.query("sessionId");
  try {
    const loops = await loopController.list(sessionId);
    return c.json({ loops });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

export async function handleGetLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const loopId = c.req.param("loopId") ?? "";
  try {
    const loop = await loopController.get(loopId);
    if (!loop) {
      return c.json({ error: "Loop not found" }, 404);
    }
    return c.json(loop);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

export async function handleUpdateLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const loopId = c.req.param("loopId") ?? "";
  const body = await c.req.json<UpdateLoopRequest>();
  try {
    const loop = await loopController.update(loopId, body);
    return c.json(loop);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("Loop not found")) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
}

export async function handlePlayLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const loopId = c.req.param("loopId") ?? "";
  try {
    const loop = await loopController.play(loopId);
    return c.json(loop);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("Loop not found")) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
}

export async function handlePauseLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const loopId = c.req.param("loopId") ?? "";
  try {
    const loop = await loopController.pause(loopId);
    return c.json(loop);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("Loop not found")) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
}

export async function handleDeleteLoop(
  c: Context<ConfigContext>,
): Promise<Response> {
  const loopId = c.req.param("loopId") ?? "";
  try {
    await loopController.remove(loopId);
    return c.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("Loop not found")) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
}
