export type PromptWatchOptions = {
  /** After this many ms, fire onStillRunning() once while the prompt is still pending. 0 disables. */
  notifyMs: number;
  /** After this many ms, the awaited prompt rejects with an Error carrying hardTimeoutMessage. 0 disables. */
  hardMs: number;
  /** Error message used when the hard timeout fires. */
  hardTimeoutMessage: string;
  /** Fired once when notifyMs elapses and the prompt is still pending. Must never fail the prompt. */
  onStillRunning?: () => void;
  /** Called when the hard timeout fires; use it to abort the underlying run so it is not left busy. */
  onHardTimeout?: () => Promise<void> | void;
};

/**
 * Awaits a prompt promise with an optional "still working" notice threshold and
 * an optional hard timeout.
 *
 * The notify threshold NEVER fails the prompt — it only observes, so long-running
 * tasks are never reported as failed just because they take a while. Only the
 * hard timeout (opt-in) rejects, and the caller is expected to abort the
 * underlying run via onHardTimeout so the session does not keep running in the
 * background (which would otherwise leave it busy for follow-up messages).
 */
export async function waitForPrompt(prompt: Promise<unknown>, options: PromptWatchOptions): Promise<void> {
  const { notifyMs, hardMs, hardTimeoutMessage, onStillRunning, onHardTimeout } = options;

  if (notifyMs <= 0 && hardMs <= 0) {
    await prompt;
    return;
  }

  let notifyTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let hardReject: ((error: Error) => void) | undefined;

  if (notifyMs > 0) {
    notifyTimer = setTimeout(() => {
      onStillRunning?.();
    }, notifyMs);
    notifyTimer.unref?.();
  }

  if (hardMs > 0) {
    hardTimer = setTimeout(() => {
      const error = new Error(hardTimeoutMessage);
      hardReject?.(error);
      void Promise.resolve(onHardTimeout?.()).catch(() => undefined);
    }, hardMs);
    hardTimer.unref?.();
  }

  try {
    if (hardMs > 0) {
      await Promise.race([
        prompt,
        new Promise<never>((_, reject) => {
          hardReject = reject;
        }),
      ]);
    } else {
      await prompt;
    }
  } finally {
    if (notifyTimer) clearTimeout(notifyTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}
