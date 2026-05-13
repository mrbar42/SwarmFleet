import { useRef, useState } from "react";

/**
 * The "project" tab in BottomNav doubles as a pull-up gesture:
 *   - Tap: navigate to the Project tab.
 *   - Drag up past the threshold: open the side panel on release.
 *
 * The "^" hat above the folder icon lifts with the drag as an affordance,
 * and tints when the threshold is crossed to signal that releasing now
 * will open the panel.
 */

interface Props {
  isActive: boolean;
  onOpenSidebar: () => void;
  onNavigateToProject: () => void;
}

const OPEN_THRESHOLD_PX = 24; // upward travel before release opens the sidebar
const HAT_MAX_LIFT_PX = 48;

export function ProjectGestureTab({
  isActive,
  onOpenSidebar,
  onNavigateToProject,
}: Props) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const startYRef = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [pressing, setPressing] = useState(false);

  const armed = pressing && dragY > OPEN_THRESHOLD_PX;

  const reset = () => {
    setPressing(false);
    setDragY(0);
    startYRef.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!btnRef.current) return;
    try {
      btnRef.current.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    startYRef.current = e.clientY;
    setPressing(true);
    setDragY(0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressing || startYRef.current === null) return;
    const dy = startYRef.current - e.clientY;
    setDragY(Math.max(0, dy));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressing || startYRef.current === null) {
      reset();
      return;
    }
    const dy = startYRef.current - e.clientY;
    if (dy > OPEN_THRESHOLD_PX) {
      onOpenSidebar();
    } else {
      onNavigateToProject();
    }
    reset();
  };

  const onPointerCancel = () => reset();

  const hatLift = Math.min(dragY, HAT_MAX_LIFT_PX);

  return (
    <button
      ref={btnRef}
      data-testid="tab-project"
      data-active={isActive ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{ touchAction: "none" }}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 min-h-[48px] relative select-none ${
        isActive
          ? "text-[#58a6ff] tab-active-indicator"
          : "text-[#8b949e] hover:text-[#c9d1d9] active:text-[#c9d1d9]"
      }`}
    >
      <span className="relative">
        {/* "^" hat lifts with the drag and tints once the threshold is crossed.
            Hidden at md+ where the sidebar is always open and the gesture is a no-op. */}
        <span
          aria-hidden="true"
          className={`md:hidden absolute left-1/2 -translate-x-1/2 pointer-events-none text-[10px] leading-none font-bold ${
            armed ? "text-[#58a6ff]" : ""
          }`}
          style={{
            top: `calc(-0.55rem - ${hatLift}px)`,
            transition: pressing ? "none" : "top 140ms ease-out",
          }}
        >
          ^
        </span>

        {/* Folder */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
          />
        </svg>
      </span>
      <span
        className={`text-[10px] leading-tight ${
          isActive ? "font-semibold" : "font-medium"
        }`}
      >
        Project
      </span>
    </button>
  );
}
