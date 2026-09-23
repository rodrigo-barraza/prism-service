import { describe, it, expect } from "vitest";
import { LuposPersona } from "#src/services/personas/LuposPersona";

// Lupos starts lean and reaches the rest of his catalog through pre-flight
// discovery, which matches tool descriptions against the user's message
// text. That works for tools users ask for by name and fails for tools
// whose trigger is a mood — the gold economy fires on rudeness and
// kindness, words that never name it. These tests pin the two halves of
// that fix: the guidance renders from the persona's own defaults, and
// every tool the guidance names is callable when it does.

const defaultEnabledTools = LuposPersona.enabledByDefaultTools ?? [];

/** The tool policy as assembled for a turn that has discovered nothing. */
function buildColdStartPolicy(locale = "en"): string {
  if (typeof LuposPersona.toolPolicy !== "function") {
    return LuposPersona.toolPolicy ?? "";
  }
  return LuposPersona.toolPolicy({
    locale,
    enabledTools: defaultEnabledTools,
    resolvedToolNames: defaultEnabledTools,
  });
}

/** The Gold Rules section alone — up to the next top-level heading. */
function extractGoldRules(policy: string): string {
  const start = policy.indexOf("# Gold Rules");
  if (start === -1) return "";
  const next = policy.indexOf("\n# ", start + 1);
  return next === -1 ? policy.slice(start) : policy.slice(start, next);
}

describe("Lupos persona tool policy", () => {
  it("states the gold economy exists on a turn that discovered nothing", () => {
    // Regression: the section was gated on a tool Lupos never enabled, so
    // the only text describing his hoard never entered the prompt and he
    // never gifted or mugged anyone.
    expect(buildColdStartPolicy()).toContain("# Gold Rules");
  });

  it("enables every gold tool its own Gold Rules name", () => {
    const goldRules = extractGoldRules(buildColdStartPolicy());
    const namedTools = [
      ...new Set(
        [...goldRules.matchAll(/`([a-z_]*gold[a-z_]*)`/g)].map(
          (match) => match[1],
        ),
      ),
    ];

    expect(namedTools.length).toBeGreaterThan(0);
    for (const toolName of namedTools) {
      expect(defaultEnabledTools).toContain(toolName);
    }
  });

  // A gift or mugging sends no receipt and no DM — the wolf's own sentence is
  // the only notification the member ever gets. An earlier draft told him the
  // amounts were "theater, not finance", and he duly wrote around them: gold
  // moved every time and nobody in the channel could tell. Both locales must
  // keep telling him to say the number out loud.
  it.each(["en", "caveman"])(
    "tells the wolf to name the amount out loud (%s)",
    (locale) => {
      const goldRules = extractGoldRules(buildColdStartPolicy(locale));

      expect(goldRules).toContain("SAY THE NUMBER");
      expect(goldRules).not.toContain("theater, not finance");
    },
  );

  // The caps live in lupos-bot (src/commands/utility/gold/luposAgentGold.ts:
  // LUPOS_GIFT_MIN/MAX = 1/5, LUPOS_MUG_MIN/MAX = 1/3) and clamp silently.
  // When the economy was cut to a tenth (lupos-bot f6c0319) this text kept
  // promising 5-50g gifts and 5-25g muggings, with 12g/15g/18g examples — a
  // wolf asking for 15g moved 3g and announced 15g. Change both together.
  it.each(["en", "caveman"])(
    "states only amounts the bot's gold caps allow (%s)",
    (locale) => {
      const goldRules = extractGoldRules(buildColdStartPolicy(locale));

      expect(goldRules).toContain("1-5g");
      expect(goldRules).toContain("1-3g");
      const amounts = [...goldRules.matchAll(/(\d+)g\b/g)].map((match) =>
        Number(match[1]),
      );
      expect(amounts.length).toBeGreaterThan(0);
      expect(Math.max(...amounts)).toBeLessThanOrEqual(5);
    },
  );
});

describe("Lupos persona reactions end the turn", () => {
  // endTurnAfterTools: a reaction sent with the reply ends the turn, so the
  // Emoji Reactions section must tell him to write the reply in that same
  // response — a reaction on its own still costs the extra round.
  it("names his emoji reaction as fire-and-forget", () => {
    expect(LuposPersona.endTurnAfterTools).toEqual(["react_to_discord_message"]);
  });

  it.each([
    ["en", "write your reply in that same response"],
    ["caveman", "write reply in SAME response as reaction"],
  ])("tells him to reply in the same response as the reaction (%s)", (locale, guidance) => {
    const policy = buildColdStartPolicy(locale);
    const start = policy.indexOf("react_to_discord_message");
    expect(start).toBeGreaterThan(-1);
    expect(policy).toContain(guidance);
  });
});

describe("Lupos persona default tools", () => {
  // Image requests are half his traffic, and an edit of a picture already in
  // the channel never names a drawing verb for pre-flight discovery to match
  // — so 73% of image turns spent a model call on discover_and_enable_tools
  // before drawing anything.
  it("can draw on the first iteration without a discovery round", () => {
    expect(defaultEnabledTools).toContain("generate_image");
  });

  // His Discord IDs block and the Participant Context section send him to
  // get_discord_user_profile for anyone beyond the one-line roster, and the
  // Discord History section to search_discord_messages. An instruction to
  // call a tool that discovery must first enable costs a model call to obey.
  it.each(["get_discord_user_profile", "search_discord_messages"])(
    "starts with %s, which his own prompt tells him to call",
    (toolName) => {
      expect(defaultEnabledTools).toContain(toolName);
    },
  );

  it.each(["en", "caveman"])(
    "renders the participant and history guidance on a turn that discovered nothing (%s)",
    (locale) => {
      const policy = buildColdStartPolicy(locale);
      for (const toolName of ["get_discord_user_profile", "search_discord_messages"]) {
        expect(policy).toContain(toolName);
      }
      expect(policy).toContain("get_discord_user_profile(guildId, userId)");
      expect(policy).toContain("## search_discord_messages");
    },
  );
});

describe("Lupos persona Discord actions section", () => {
  const DISCORD_ACTION_TOOLS = [
    "create_discord_poll",
    "create_discord_thread",
    "schedule_discord_reminder",
    "list_discord_reminders",
    "cancel_discord_reminder",
    "set_discord_nickname",
  ];

  function policyWith(toolNames: string[], locale = "en"): string {
    if (typeof LuposPersona.toolPolicy !== "function") return "";
    const enabledTools = [...defaultEnabledTools, ...toolNames];
    return LuposPersona.toolPolicy({
      locale,
      enabledTools,
      resolvedToolNames: enabledTools,
    });
  }

  /** The section alone — up to the next top-level heading. */
  function extractSection(policy: string, heading: string): string {
    const start = policy.indexOf(heading);
    if (start === -1) return "";
    const next = policy.indexOf("\n# ", start + 1);
    return next === -1 ? policy.slice(start) : policy.slice(start, next);
  }

  const HEADINGS: Record<string, string> = {
    en: "# Discord Actions",
    caveman: "# Discord Action",
  };

  // The action tools stay discoverable, not enabled by default: a turn that
  // discovered none of them must not be told how to use them.
  it("stays out of a turn that reached none of the action tools", () => {
    for (const toolName of DISCORD_ACTION_TOOLS) {
      expect(defaultEnabledTools).not.toContain(toolName);
    }
    expect(buildColdStartPolicy()).not.toContain(HEADINGS.en);
  });

  it.each(DISCORD_ACTION_TOOLS)("renders once %s reaches the model", (toolName) => {
    expect(policyWith([toolName])).toContain(HEADINGS.en);
  });

  it.each(["en", "caveman"])("names every action tool it gates on (%s)", (locale) => {
    const section = extractSection(
      policyWith(DISCORD_ACTION_TOOLS, locale),
      HEADINGS[locale],
    );
    expect(section).not.toBe("");
    for (const toolName of DISCORD_ACTION_TOOLS) {
      expect(section).toContain(`\`${toolName}\``);
    }
  });

  // lupos-bot delivers a reminder to the asker only, caps pending ones at
  // five per member, and refuses a nickname on anyone but the bot. The text
  // must promise nothing the routes will not do.
  it.each(["en", "caveman"])("states the reminder and nickname limits the bot enforces (%s)", (locale) => {
    const section = extractSection(
      policyWith(DISCORD_ACTION_TOOLS, locale),
      HEADINGS[locale],
    );
    expect(section).toMatch(/ONLY when someone ask/);
    expect(section).toMatch(/nobody else/);
    expect(section).toContain("5 pending");
    expect(section).toMatch(/plain word/);
    expect(section).toContain("OWN name");
    expect(section).toMatch(/[Nn]ever (a )?slur/);
  });
});
