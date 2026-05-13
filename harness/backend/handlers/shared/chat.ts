import { Context } from "hono";
import type {
  ChatRequest,
  CreateSessionRequest,
  SessionMessageRequest,
  StreamResponse,
} from "../../../shared/types.ts";
import { getEncodedProjectName } from "../../history/pathUtils.ts";
import { sessionManager } from "../../services/sessionManager.ts";
import { logger } from "../../utils/logger.ts";

function fallbackEncodedProjectName(projectPath: string): string {
  return projectPath.replace(/[/\\:._]/g, "-");
}

async function resolveEncodedProjectName(
  projectPath: string,
): Promise<string | null> {
  const encoded = await getEncodedProjectName(projectPath);
  return encoded ?? fallbackEncodedProjectName(projectPath);
}

export async function handleChatRequest(c: Context) {
  const chatRequest = await c.req.json<ChatRequest>();
  const { cliPath } = c.var.config;
  sessionManager.configure({ cliPath });

  logger.chat.debug(
    "Received legacy chat request {*}",
    chatRequest as unknown as Record<string, unknown>,
  );

  if (
    typeof chatRequest.message !== "string" ||
    (!chatRequest.message.trim() && (chatRequest.attachments?.length ?? 0) === 0)
  ) {
    return c.json({ error: "message is required" }, 400);
  }

  const projectPath = chatRequest.workingDirectory ?? process.cwd();
  const encodedProjectName = await resolveEncodedProjectName(projectPath);

  let session =
    chatRequest.sessionId != null
      ? await sessionManager.get(chatRequest.sessionId)
      : null;

  if (!session && chatRequest.sessionId) {
    session = await sessionManager.getByProviderSessionId(
      chatRequest.sessionId,
      projectPath,
    );
  }

  if (!session) {
    const createRequest: CreateSessionRequest = {
      projectPath,
      encodedProjectName,
      providerSessionId: chatRequest.sessionId ?? null,
      model: chatRequest.model,
      permissionMode: chatRequest.permissionMode,
      effort: chatRequest.effort,
      allowedTools: chatRequest.allowedTools,
    };
    session = await sessionManager.create(createRequest);
  }

  const lastEventId = session.latestEventId;
  const messageRequest: SessionMessageRequest = {
    message: chatRequest.message,
    requestId: chatRequest.requestId,
    permissionMode: chatRequest.permissionMode,
    model: chatRequest.model,
    effort: chatRequest.effort,
    allowedTools: chatRequest.allowedTools,
    attachments: chatRequest.attachments,
  };

  await sessionManager.sendMessage(session.sessionId, messageRequest);

  let cursor = lastEventId;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const pollHandle = setInterval(async () => {
        try {
          const events = await sessionManager.getEventsSince(
            session.sessionId,
            cursor,
          );
          if (events === null) {
            close();
            clearInterval(pollHandle);
            return;
          }

          for (const event of events) {
            cursor = event.id;
            if (event.channel !== "stream") {
              continue;
            }

            const response = event.data as StreamResponse;
            controller.enqueue(
              encoder.encode(`${JSON.stringify(response)}\n`),
            );

            if (
              response.type === "done" ||
              response.type === "error" ||
              response.type === "aborted"
            ) {
              clearInterval(pollHandle);
              close();
              return;
            }
          }
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "error",
                error: error instanceof Error ? error.message : String(error),
              })}\n`,
            ),
          );
          clearInterval(pollHandle);
          close();
        }
      }, 500);

      c.req.raw.signal.addEventListener(
        "abort",
        () => {
          clearInterval(pollHandle);
          close();
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
