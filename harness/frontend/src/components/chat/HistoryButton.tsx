import { ClockIcon } from "@heroicons/react/24/outline";

interface HistoryButtonProps {
  onClick: () => void;
}

export function HistoryButton({ onClick }: HistoryButtonProps) {
  return (
    <button
      onClick={onClick}
      data-testid="chat-history"
      className="p-1 rounded text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
      aria-label="View conversation history"
    >
      <ClockIcon className="w-4 h-4" />
    </button>
  );
}
