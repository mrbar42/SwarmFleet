import { useEffect, useRef } from "react";

interface FileTabMenuProps {
  filePath: string;
  isTab: boolean; // true = opened from tab, false = from explorer
  onClose: () => void;
  onCopyPath: () => void;
  onMentionInChat: () => void;
  onCloseOtherTabs: () => void;
  onCloseAllTabs: () => void;
}

export function FileTabMenu({
  filePath,
  isTab,
  onClose,
  onCopyPath,
  onMentionInChat,
  onCloseOtherTabs,
  onCloseAllTabs,
}: FileTabMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Small delay to prevent the long-press event from immediately closing
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("touchstart", handler);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onClose]);

  const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
    { label: "Copy relative path", action: onCopyPath },
    { label: "Mention in chat", action: onMentionInChat },
  ];

  if (isTab) {
    items.push(
      { label: "Close other tabs", action: onCloseOtherTabs },
      { label: "Close all tabs", action: onCloseAllTabs, danger: true },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        ref={ref}
        className="bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl w-64 overflow-hidden"
      >
        {/* Header: file path */}
        <div className="px-4 py-2.5 border-b border-[#30363d] text-xs text-[#8b949e] truncate font-mono">
          {filePath}
        </div>

        {/* Actions */}
        {items.map((item) => (
          <button
            key={item.label}
            onClick={() => {
              item.action();
              onClose();
            }}
            className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
              item.danger
                ? "text-[#f85149] hover:bg-[#f8514910]"
                : "text-[#c9d1d9] hover:bg-[#1c2129]"
            }`}
          >
            {item.label}
          </button>
        ))}

        {/* Cancel */}
        <button
          onClick={onClose}
          className="w-full text-left px-4 py-2.5 text-sm text-[#8b949e] hover:bg-[#1c2129] border-t border-[#30363d]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
