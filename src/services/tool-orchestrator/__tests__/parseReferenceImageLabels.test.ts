/**
 * Unit tests for ToolOrchestratorService.parseReferenceImageLabels —
 * recovering the name↔image binding from a message's
 * <attached-reference-images> block.
 *
 * Regression: generate_image auto-injected the last user message's images
 * as an anonymous URL array, so the image model bound prompt names to
 * faces by guesswork — a Discord group portrait labeled the wrong people
 * (agent_conversation ca14f123, Yamz rendered as "GRIEVOUS").
 */
import { describe, it, expect } from "vitest";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

const LUPOS_BLOCK = `<discord-message id="1" author="RODS BIG MAYO BOY">
<content>
DRAW ALL OF WHITEMANE POL CHATTERS
</content>
</discord-message>

<attached-reference-images>

1. RODS BIG MAYO BOY's avatar/profile picture
   URL: https://cdn.discordapp.com/avatars/213542650341621760/ee90.png?size=512
2. Gerfs's avatar/profile picture
   URL: https://cdn.discordapp.com/guilds/609/users/150/avatars/01be.png?size=512
3. Yamz's avatar/profile picture
   URL: https://cdn.discordapp.com/avatars/824386571825709076/58c4.png?size=512

</attached-reference-images>`;

describe("parseReferenceImageLabels", () => {
  it("returns positional labels matching the block's numbering", () => {
    const { labels } =
      ToolOrchestratorService.parseReferenceImageLabels(LUPOS_BLOCK);
    expect(labels).toEqual([
      "RODS BIG MAYO BOY's avatar/profile picture",
      "Gerfs's avatar/profile picture",
      "Yamz's avatar/profile picture",
    ]);
  });

  it("maps the block's URL lines back to their labels", () => {
    const { labelByUrl } =
      ToolOrchestratorService.parseReferenceImageLabels(LUPOS_BLOCK);
    expect(
      labelByUrl.get(
        "https://cdn.discordapp.com/avatars/824386571825709076/58c4.png?size=512",
      ),
    ).toBe("Yamz's avatar/profile picture");
    expect(labelByUrl.size).toBe(3);
  });

  it("keeps entry captions as part of the label", () => {
    const content = `<attached-reference-images>

1. THE IMAGE BEING DISCUSSED (from the replied-to message, posted by you): Chibi characters play at a playground.
   URL: https://media.discordapp.net/attachments/1/2/scene.jpg

</attached-reference-images>`;
    const { labels } =
      ToolOrchestratorService.parseReferenceImageLabels(content);
    expect(labels[0]).toBe(
      "THE IMAGE BEING DISCUSSED (from the replied-to message, posted by you): Chibi characters play at a playground.",
    );
  });

  it("keeps positional alignment for entries without a URL line (data: URIs)", () => {
    const content = `<attached-reference-images>

1. Emoji: chadge — a smug face
2. Rodrigo's avatar/profile picture
   URL: https://cdn.discordapp.com/avatars/166745313258897409/46ae.png?size=512

</attached-reference-images>`;
    const { labels, labelByUrl } =
      ToolOrchestratorService.parseReferenceImageLabels(content);
    expect(labels).toEqual([
      "Emoji: chadge — a smug face",
      "Rodrigo's avatar/profile picture",
    ]);
    expect(labelByUrl.size).toBe(1);
  });

  it("uses the LAST block when several appear in the content", () => {
    const content = `<attached-reference-images>

1. Stale entry from a quoted message
</attached-reference-images>

more text

<attached-reference-images>

1. Fresh entry for this message's images
</attached-reference-images>`;
    const { labels } =
      ToolOrchestratorService.parseReferenceImageLabels(content);
    expect(labels).toEqual(["Fresh entry for this message's images"]);
  });

  it("returns empty results for content without a block or non-string content", () => {
    expect(
      ToolOrchestratorService.parseReferenceImageLabels("just a message"),
    ).toEqual({ labels: [], labelByUrl: new Map() });
    expect(
      ToolOrchestratorService.parseReferenceImageLabels(undefined),
    ).toEqual({ labels: [], labelByUrl: new Map() });
  });
});
