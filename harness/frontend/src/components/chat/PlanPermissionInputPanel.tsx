import { useState, useEffect, useCallback } from "react";

interface PlanPermissionInputPanelProps {
  onAcceptWithEdits: () => void;
  onAcceptDefault: () => void;
  onKeepPlanning: () => void;
  getButtonClassName?: (
    buttonType: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
    defaultClassName: string,
  ) => string;
  onSelectionChange?: (
    selection: "acceptWithEdits" | "acceptDefault" | "keepPlanning",
  ) => void;
  externalSelectedOption?:
    | "acceptWithEdits"
    | "acceptDefault"
    | "keepPlanning"
    | null;
}

export function PlanPermissionInputPanel({
  onAcceptWithEdits,
  onAcceptDefault,
  onKeepPlanning,
  getButtonClassName = (_, defaultClassName) => defaultClassName,
  onSelectionChange,
  externalSelectedOption,
}: PlanPermissionInputPanelProps) {
  const [selectedOption, setSelectedOption] = useState<
    "acceptWithEdits" | "acceptDefault" | "keepPlanning" | null
  >("acceptWithEdits");

  const isExternallyControlled = externalSelectedOption !== undefined;
  const effectiveSelectedOption = externalSelectedOption ?? selectedOption;

  const updateSelectedOption = useCallback(
    (option: "acceptWithEdits" | "acceptDefault" | "keepPlanning") => {
      if (externalSelectedOption === undefined) {
        setSelectedOption(option);
      }
      onSelectionChange?.(option);
    },
    [onSelectionChange, externalSelectedOption],
  );

  useEffect(() => {
    if (externalSelectedOption !== undefined) return;

    const options = [
      "acceptWithEdits",
      "acceptDefault",
      "keepPlanning",
    ] as const;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const currentIndex = options.indexOf(effectiveSelectedOption!);
        const nextIndex = (currentIndex + 1) % options.length;
        updateSelectedOption(options[nextIndex]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const currentIndex = options.indexOf(effectiveSelectedOption!);
        const prevIndex = (currentIndex - 1 + options.length) % options.length;
        updateSelectedOption(options[prevIndex]);
      } else if (e.key === "Enter" && effectiveSelectedOption) {
        e.preventDefault();
        if (effectiveSelectedOption === "acceptWithEdits") onAcceptWithEdits();
        else if (effectiveSelectedOption === "acceptDefault") onAcceptDefault();
        else if (effectiveSelectedOption === "keepPlanning") onKeepPlanning();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onKeepPlanning();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    effectiveSelectedOption,
    onAcceptDefault,
    onAcceptWithEdits,
    onKeepPlanning,
    updateSelectedOption,
    externalSelectedOption,
  ]);

  return (
    <div className="flex-shrink-0 px-4 py-4 bg-[#161b22] border border-[#30363d] rounded-xl">
      <div className="mb-4">
        <p className="text-sm text-[#8b949e]">
          Choose how to proceed (Press ESC to keep planning)
        </p>
      </div>

      <div className="space-y-2">
        <button
          onClick={() => {
            updateSelectedOption("acceptWithEdits");
            onAcceptWithEdits();
          }}
          onFocus={() => updateSelectedOption("acceptWithEdits")}
          onBlur={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          onMouseEnter={() => updateSelectedOption("acceptWithEdits")}
          onMouseLeave={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          className={getButtonClassName(
            "acceptWithEdits",
            `w-full p-3 rounded-lg cursor-pointer transition-all duration-200 text-left focus:outline-none ${
              effectiveSelectedOption === "acceptWithEdits"
                ? "bg-[#0f2d1a] border-2 border-[#238636] shadow-sm"
                : "border-2 border-transparent"
            }`,
          )}
        >
          <span
            className={`text-sm font-medium ${
              effectiveSelectedOption === "acceptWithEdits"
                ? "text-[#3fb950]"
                : "text-[#c9d1d9]"
            }`}
          >
            Yes, and auto-accept edits
          </span>
        </button>

        <button
          onClick={() => {
            updateSelectedOption("acceptDefault");
            onAcceptDefault();
          }}
          onFocus={() => updateSelectedOption("acceptDefault")}
          onBlur={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          onMouseEnter={() => updateSelectedOption("acceptDefault")}
          onMouseLeave={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          className={getButtonClassName(
            "acceptDefault",
            `w-full p-3 rounded-lg cursor-pointer transition-all duration-200 text-left focus:outline-none ${
              effectiveSelectedOption === "acceptDefault"
                ? "bg-[#0c2d48] border-2 border-[#1f6feb] shadow-sm"
                : "border-2 border-transparent"
            }`,
          )}
        >
          <span
            className={`text-sm font-medium ${
              effectiveSelectedOption === "acceptDefault"
                ? "text-[#58a6ff]"
                : "text-[#c9d1d9]"
            }`}
          >
            Yes, and manually approve edits
          </span>
        </button>

        <button
          onClick={() => {
            updateSelectedOption("keepPlanning");
            onKeepPlanning();
          }}
          onFocus={() => updateSelectedOption("keepPlanning")}
          onBlur={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          onMouseEnter={() => updateSelectedOption("keepPlanning")}
          onMouseLeave={() => {
            if (!isExternallyControlled) setSelectedOption(null);
          }}
          className={getButtonClassName(
            "keepPlanning",
            `w-full p-3 rounded-lg cursor-pointer transition-all duration-200 text-left focus:outline-none ${
              effectiveSelectedOption === "keepPlanning"
                ? "bg-[#21262d] border-2 border-[#484f58] shadow-sm"
                : "border-2 border-transparent"
            }`,
          )}
        >
          <span
            className={`text-sm font-medium ${
              effectiveSelectedOption === "keepPlanning"
                ? "text-[#e6edf3]"
                : "text-[#c9d1d9]"
            }`}
          >
            No, keep planning
          </span>
        </button>
      </div>
    </div>
  );
}
