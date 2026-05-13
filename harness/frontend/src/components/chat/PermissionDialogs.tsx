import { useCallback } from "react";
import { useChatStore } from "../../stores/chatStore";
import { sendMessage } from "./sendMessage";

export interface PlanPermissionData {
  onAcceptWithEdits: () => void;
  onAcceptDefault: () => void;
  onKeepPlanning: () => void;
}

/**
 * Hook that derives plan-permission callbacks from the chat store's
 * `planModeRequest` state and the caller's project identifiers.
 *
 * Returns `undefined` when no plan approval is pending, or the
 * `PlanPermissionData` object that ChatInput expects.
 */
export function usePlanPermission(
  workingDirectory: string | undefined,
  encodedName: string | null,
): PlanPermissionData | undefined {
  const planModeRequest = useChatStore((state) => state.planModeRequest);

  const handlePlanAcceptWithEdits = useCallback(() => {
    const store = useChatStore.getState();
    store.setPermissionMode("acceptEdits");
    void sendMessage(workingDirectory, encodedName, "accept", store.allowedTools, true, "acceptEdits");
  }, [workingDirectory, encodedName]);

  const handlePlanAcceptDefault = useCallback(() => {
    const store = useChatStore.getState();
    store.setPermissionMode("bypassPermissions");
    void sendMessage(workingDirectory, encodedName, "accept", store.allowedTools, true, "bypassPermissions");
  }, [workingDirectory, encodedName]);

  const handlePlanKeepPlanning = useCallback(() => {
    const store = useChatStore.getState();
    store.setPermissionMode("plan");
    store.resolvePlanApproval();
  }, []);

  if (!planModeRequest?.isOpen) {
    return undefined;
  }

  return {
    onAcceptWithEdits: handlePlanAcceptWithEdits,
    onAcceptDefault: handlePlanAcceptDefault,
    onKeepPlanning: handlePlanKeepPlanning,
  };
}
