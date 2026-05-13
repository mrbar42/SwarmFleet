import { useState, useCallback } from "react";
import {
  PencilIcon,
  PaperAirplaneIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { QueuedMessage } from "../../types";
import {
  getSessionQueueItemUrl,
  getSessionQueueSendNowUrl,
} from "../../config/api";
import { useChatStore } from "../../stores/chatStore";

interface PendingMessagesQueueProps {
  sessionId: string;
  queued: QueuedMessage[];
}

async function deleteQueued(
  sessionId: string,
  queuedId: string,
): Promise<void> {
  await fetch(getSessionQueueItemUrl(sessionId, queuedId), {
    method: "DELETE",
  });
}

async function sendNowQueued(
  sessionId: string,
  queuedId: string,
): Promise<void> {
  await fetch(getSessionQueueSendNowUrl(sessionId, queuedId), {
    method: "POST",
  });
}

export function PendingMessagesQueue({
  sessionId,
  queued,
}: PendingMessagesQueueProps) {
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const setInput = useChatStore((state) => state.setInput);

  const handleRowTap = useCallback((id: string) => {
    setActiveRowId((prev) => (prev === id ? null : id));
  }, []);

  const handleEdit = useCallback(
    (item: QueuedMessage) => {
      void deleteQueued(sessionId, item.id);
      setInput(item.message);
      setActiveRowId(null);
    },
    [sessionId, setInput],
  );

  const handleDelete = useCallback(
    (id: string) => {
      void deleteQueued(sessionId, id);
      setActiveRowId(null);
    },
    [sessionId],
  );

  const handleSendNow = useCallback(
    (id: string) => {
      void sendNowQueued(sessionId, id);
      setActiveRowId(null);
    },
    [sessionId],
  );

  if (queued.length === 0) return null;

  return (
    <div className="md:max-w-[750px] mx-auto w-full">
      {queued.map((item, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === queued.length - 1;
        const isMobileActive = activeRowId === item.id;

        return (
          <div
            key={item.id}
            className="group relative flex items-center bg-[#161b22] border-x border-t border-[#30363d] first:rounded-t-xl px-4 py-2 gap-2 cursor-default select-none"
            onClick={() => handleRowTap(item.id)}
          >
            {/* Queue position indicator */}
            <span className="flex-shrink-0 text-[10px] font-mono text-[#484f58] w-4 text-right leading-none">
              {idx + 1}
            </span>

            {/* Message preview — truncated to one line */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {item.attachments && item.attachments.length > 0 && (
                <div className="flex flex-shrink-0 -space-x-1">
                  {item.attachments
                    .slice(0, 3)
                    .map((attachment, attachmentIdx) => (
                      <img
                        key={attachmentIdx}
                        src={`data:${attachment.media_type};base64,${attachment.base64}`}
                        alt={`Queued attachment ${attachmentIdx + 1}`}
                        className="h-6 w-6 rounded border border-[#30363d] bg-black object-cover"
                      />
                    ))}
                </div>
              )}
              <span className="min-w-0 flex-1 truncate text-sm leading-5 text-[#8b949e]">
                {item.message}
              </span>
            </div>

            {/* Action buttons */}
            <div
              className={`flex items-center gap-1 flex-shrink-0 transition-opacity duration-150 ${
                isMobileActive
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Send now — only on the first item */}
              {isFirst && (
                <button
                  type="button"
                  onClick={() => handleSendNow(item.id)}
                  className="p-1 rounded text-[#484f58] hover:text-[#58a6ff] hover:bg-[#1c2129] transition-colors duration-150"
                  title="Send now"
                >
                  <PaperAirplaneIcon className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Edit — only on the last item */}
              {isLast && (
                <button
                  type="button"
                  onClick={() => handleEdit(item)}
                  className="p-1 rounded text-[#484f58] hover:text-[#e6edf3] hover:bg-[#1c2129] transition-colors duration-150"
                  title="Edit (unqueue)"
                >
                  <PencilIcon className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Delete — always visible */}
              <button
                type="button"
                onClick={() => handleDelete(item.id)}
                className="p-1 rounded text-[#484f58] hover:text-[#f85149] hover:bg-[#3d1214] transition-colors duration-150"
                title="Delete"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
