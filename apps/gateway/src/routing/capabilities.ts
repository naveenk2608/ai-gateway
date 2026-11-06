import type { ToolChoiceKind } from '../providers/dialects.js';
import type { Deployment, Route } from '../providers/registry.js';
import { messageImages, type ChatRequest } from '../providers/types.js';

/** What a chat request asks of a deployment beyond plain text (ADR 028). */
export interface Needs {
  /** Tools are given, or the conversation already holds tool calls or tool results. */
  tools: boolean;
  /** A `tool_choice` other than `auto` (which every provider takes). */
  toolChoice: ToolChoiceKind | undefined;
  jsonObject: boolean;
  jsonSchema: boolean;
  /** Images in user messages. */
  images: number;
  /** At least one image is an `https:` URL rather than a `data:` URL. */
  imageUrls: boolean;
}

export type NeedsInput = Pick<ChatRequest, 'messages' | 'tools' | 'toolChoice' | 'responseFormat'>;

export function needsOf(req: NeedsInput): Needs {
  const images = req.messages.flatMap((m) => messageImages(m.content));
  const choice = req.toolChoice;
  return {
    tools:
      (req.tools?.length ?? 0) > 0 ||
      req.messages.some((m) => m.role === 'tool' || (m.toolCalls?.length ?? 0) > 0),
    toolChoice:
      choice === undefined || choice === 'auto'
        ? undefined
        : typeof choice === 'object'
          ? 'named'
          : choice,
    jsonObject: req.responseFormat?.type === 'json_object',
    jsonSchema: req.responseFormat?.type === 'json_schema',
    images: images.length,
    imageUrls: images.some((image) => !image.url.startsWith('data:')),
  };
}

/** The field a missing capability is about, for the 400's `param`. */
export type NeedParam = 'tools' | 'tool_choice' | 'response_format' | 'messages';

export interface Missing {
  /** What the deployment lacks, as the client would name it, e.g. `tools`. */
  what: string;
  param: NeedParam;
}

/**
 * What the deployment lacks for the request, or undefined when it can serve it: its model's
 * capabilities from the models file, and what its provider's API takes (dialects.ts).
 */
export function missingFor(deployment: Deployment, needs: Needs): Missing | undefined {
  const { capabilities: can, dialect } = deployment;
  if (needs.tools && !can.tools) return { what: 'tools', param: 'tools' };
  if (needs.toolChoice !== undefined && !dialect.toolChoices.has(needs.toolChoice)) {
    const value = needs.toolChoice === 'named' ? 'a named function' : `"${needs.toolChoice}"`;
    return { what: `tool_choice ${value}`, param: 'tool_choice' };
  }
  if (needs.jsonSchema && !can.json_schema) {
    return { what: 'response_format json_schema', param: 'response_format' };
  }
  if (needs.jsonSchema && needs.tools && !dialect.jsonSchemaWithTools) {
    return { what: 'response_format json_schema together with tools', param: 'response_format' };
  }
  if (needs.jsonObject && !can.json_object) {
    return { what: 'response_format json_object', param: 'response_format' };
  }
  if (needs.images > 0 && !can.vision) return { what: 'image input', param: 'messages' };
  if (needs.imageUrls && !dialect.imageUrls) {
    return { what: 'images by URL (send them as data: URLs)', param: 'messages' };
  }
  return undefined;
}

export interface FittedRoute {
  /** The route with only the deployments that can serve the request; null when none can. */
  route: Route | null;
  /** The deployments left out and why, for the first try's routing reason: `x (no tools)`. */
  unfit: string[];
  /** What the first deployment lacks, when none can serve the request. */
  missing: Missing | undefined;
}

/**
 * Keeps the route's deployments that can serve the request (ADR 028). The others are skipped
 * before admission, so their prices do not count in the budget reservation, and they are named in
 * the routing trace like deployments skipped for an open breaker.
 */
export function fitRoute(route: Route, needs: Needs): FittedRoute {
  const unfit: string[] = [];
  let missing: Missing | undefined;
  const targets = route.targets.filter((target) => {
    const lacks = missingFor(target.deployment, needs);
    if (lacks === undefined) return true;
    missing ??= lacks;
    unfit.push(`${target.deployment.id} (no ${lacks.what})`);
    return false;
  });
  return { route: targets.length > 0 ? { ...route, targets } : null, unfit, missing };
}
