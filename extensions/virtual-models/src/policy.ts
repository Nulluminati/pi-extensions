/** Task-boundary policy. No task IDs, expected answers, or fixture labels enter these decisions. */
export const POLICY_VERSION = "teop-policy-v1";
export const MODEL_POOL = {
  sol: "openai-codex/gpt-6.1-sol",
  deepseek: "opencode-go/deepseek-v4.1-flash",
  glm: "zai/glm-5.3-flash",
} as const;
export type ModelChoice = keyof typeof MODEL_POOL;

export function ruleChoice(prompt: string): ModelChoice {
  const evidence = prompt.slice(0, 12000);
  if (
    /optimal|nonpreemptive|safety violations|security|race condition|architecture|multi-file|cross-cutting/i.test(
      evidence,
    )
  )
    return "sol";
  if (/rename|diagnos|regression test|implement|fix only|fix the|broken/i.test(evidence))
    return "deepseek";
  return "glm";
}

export function subscriptionExhausted(message: string): boolean {
  return /quota.{0,60}(exhaust|exceed|limit|reach)|subscription.{0,60}(exhaust|limit|reset)|usage limit|insufficient.{0,20}(credit|balance)|credit.{0,20}(exhaust|insufficient)|weekly limit|monthly limit/i.test(
    message,
  );
}
