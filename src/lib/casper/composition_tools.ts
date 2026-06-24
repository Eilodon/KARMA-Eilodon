/**
 * MCP-shaped tool surface for the Casper composition primitive (T2.1, Option B).
 *
 * Mirrors the in-process MCP envelope used by `demo_casper_composability` ({ name, description,
 * handler }) so the same orchestrator code that drives a live StdioMcpClient can register +
 * discover + invoke composite skills against the in-process `OdraRegistry`. Handlers are async so
 * that validation failures surface as rejected promises (structured tool errors), not throws that
 * escape the call envelope.
 */

import { CompositionError } from "./odra_registry.js";
import type { OdraRegistry, Composition } from "./odra_registry.js";

export interface McpTool {
  name: string;
  description: string;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export interface RegisterCompositionResult {
  skillId: number;
  isComposite: boolean;
  composition: Composition | null;
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value) && value.every((v): v is number => typeof v === "number")) {
    return value;
  }
  // Structural shape error reuses the nearest composition code.
  throw new CompositionError("WeightsMismatch");
}

export function buildCompositionTools(reg: OdraRegistry): McpTool[] {
  return [
    {
      name: "register_composition",
      description:
        "Register a composite skill bundling N child skills with a basis-points weight vector " +
        "(Σ = 10000). Validates leaf count (1..8), weight length/sum, and that every leaf exists, " +
        "is active, and is not itself composite. Returns the composite skill id.",
      async handler(args: Record<string, unknown>): Promise<RegisterCompositionResult> {
        const skillId = reg.register_composition(
          String(args.wrapperOwner),
          { name: String(args.name), price: BigInt(String(args.price)) },
          asNumberArray(args.leafSkillIds),
          asNumberArray(args.weightsBps),
        );
        return { skillId, isComposite: reg.is_composite(skillId), composition: reg.get_composition(skillId) };
      },
    },
    {
      name: "discover_composites",
      description:
        "List every registered composite skill with its manifest (leaf skill ids + weights), so a " +
        "discovering agent can compose over existing primitives without bespoke integration.",
      async handler(): Promise<Array<{ skillId: number; composition: Composition }>> {
        return reg.list_composites();
      },
    },
    {
      name: "get_composition",
      description: "Return the composition manifest for a composite skill id, or reject if the skill is primitive.",
      async handler(args: Record<string, unknown>): Promise<Composition> {
        const manifest = reg.get_composition(Number(args.skillId));
        if (!manifest) throw new CompositionError("NotComposite");
        return manifest;
      },
    },
  ];
}
