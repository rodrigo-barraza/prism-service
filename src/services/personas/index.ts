import { Persona } from "./types.ts";
import { CodingPersona } from "./CodingPersona.ts";
import { LuposPersona } from "./LuposPersona.ts";
import { StickersPersona } from "./StickersPersona.ts";
import { LightsPersona } from "./LightsPersona.ts";
import { OogPersona } from "./OogPersona.ts";
import { DigestPersona } from "./DigestPersona.ts";
import { MetaPersona } from "./MetaPersona.ts";
import { OmniPersona } from "./OmniPersona.ts";
import { ImagePersona } from "./ImagePersona.ts";
import { MeepoPersona } from "./MeepoPersona.ts";

export * from "./types.ts";
export * from "./utils.ts";

export const BUILT_IN_PERSONAS = new Map<string, Persona>([
  ["CODING", CodingPersona],
  ["LUPOS", LuposPersona],
  ["STICKERS", StickersPersona],
  ["LIGHTS", LightsPersona],
  ["OOG", OogPersona],
  ["DIGEST", DigestPersona],
  ["META", MetaPersona],
  ["OMNI", OmniPersona],
  ["IMAGE", ImagePersona],
  ["MEEPO", MeepoPersona],
]);
