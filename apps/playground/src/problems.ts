import type { GatewayProblem } from './gateway.js';

/** A wait in the largest sensible unit: "45 s", "3 min", "2 h", "4 days". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} min`;
  if (seconds < 2 * 86_400) return `${Math.ceil(seconds / 3_600)} h`;
  return `${Math.ceil(seconds / 86_400)} days`;
}

/** What went wrong, for people: a title and what to do about it. */
export function describeProblem(
  problem: GatewayProblem,
  context: { model?: string; origin?: string } = {},
): { title: string; detail: string } {
  const retry =
    problem.retryAfterSeconds === null
      ? ''
      : ` Try again in ${formatWait(problem.retryAfterSeconds)}.`;
  switch (problem.kind) {
    case 'auth':
      return {
        title: 'The gateway rejected this API key',
        detail: `${problem.message} Check the key in Settings: it may be mistyped, revoked or expired.`,
      };
    case 'forbidden':
      return {
        title: 'This model is not allowed for this key',
        detail: `${problem.message} Pick another model, or ask a project admin to allow ${
          context.model ? `\`${context.model}\`` : 'it'
        }.`,
      };
    case 'not_found':
      return {
        title: 'Model not found',
        detail: `${problem.message} Reload the model list in Settings.`,
      };
    case 'rate_limit':
      return { title: 'Rate limit reached', detail: `${problem.message}${retry}` };
    case 'budget':
      return {
        title: "The project's monthly budget is used up",
        detail:
          `${problem.message} Requests are refused until the next UTC month starts or an admin ` +
          `raises the budget.${problem.retryAfterSeconds === null ? '' : ` The month ends in ${formatWait(problem.retryAfterSeconds)}.`}`,
      };
    case 'bad_request':
      return { title: 'The gateway refused the request', detail: problem.message };
    case 'unavailable':
      return {
        title: 'The gateway is temporarily unavailable',
        detail: `${problem.message}${retry || ' Try again shortly.'}`,
      };
    case 'unreachable':
      return {
        title: 'Could not reach the gateway',
        detail:
          'If it was idle, it is probably waking up: free hosting sleeps when unused, and waking ' +
          'takes up to a minute. Try again shortly. If it keeps failing, check the gateway URL ' +
          `and that the gateway's ALLOWED_ORIGINS includes ${context.origin ?? 'this site'}.`,
      };
    case 'server':
      return { title: 'The request failed', detail: problem.message };
  }
}
