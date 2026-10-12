import { describe, expect, it } from "vitest";
import {
  decodeEffects,
  encodeEffects,
  filterProfanity,
  isReservedName,
  maskContactDetails,
  nameKey,
  normaliseName,
  parseEffects,
  sanitiseChat,
} from "./chat";

describe("filterProfanity", () => {
  it("masks blocked words, keeping length", () => {
    expect(filterProfanity("fuck off")).toBe("**** off");
    expect(filterProfanity("what the fUcK")).toBe("what the ****");
  });

  it("sees through leetspeak and separators", () => {
    expect(filterProfanity("sh1t")).toBe("****");
    expect(filterProfanity("f.u.c.k")).toBe("*******");
    expect(filterProfanity("s h i t")).toBe("* * * *");
    expect(filterProfanity("$h!t")).toBe("****");
  });

  it("only blocks short stems when they stand alone", () => {
    expect(filterProfanity("kys")).toBe("***");
    expect(filterProfanity("skys the limit")).toBe("skys the limit");
    expect(filterProfanity("fag")).toBe("***");
    expect(filterProfanity("dickens")).toBe("dickens");
    expect(filterProfanity("grape therapist rapeseed")).toBe("grape therapist rapeseed");
    expect(filterProfanity("spice")).toBe("spice");
  });

  it("lets ordinary trading talk through", () => {
    for (const text of ["assets", "cocktail", "classic", "night", "cocky", "1.5 usdc", "rate is 0.79"]) {
      expect(filterProfanity(text)).toBe(text);
    }
  });

  it("does not mask place names that contain a blocked stem (Scunthorpe problem)", () => {
    for (const text of ["I live in Scunthorpe", "Matsushita", "grape juice", "Dickens", "spices", "class", "Niger", "Nigeria"]) {
      expect(filterProfanity(text)).toBe(text);
    }
  });

  it("masks words at the edges, inside words, leet and spaced out", () => {
    expect(filterProfanity("bullshit")).toBe("********");
    expect(filterProfanity("motherfucker")).toBe("************");
    expect(filterProfanity("fuuuck off")).toBe("****** off");
    expect(filterProfanity("sh1t")).toBe("****");
    expect(filterProfanity("f u c k")).toBe("* * * *");
    expect(filterProfanity("fag")).toBe("***");
  });
});

describe("maskContactDetails", () => {
  it("keeps dollar amounts but masks cashtags", () => {
    expect(maskContactDetails("pay $100 now")).toBe("pay $100 now");
    expect(maskContactDetails("$100")).toBe("$100");
    expect(maskContactDetails("send to $alice")).toBe("send to ******");
  });

  it("masks wallet addresses but not short hex", () => {
    expect(maskContactDetails("0xabc")).toBe("0xabc");
    expect(maskContactDetails("0xabcdef1234")).toBe("************");
    const address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(maskContactDetails(`my wallet ${address}`)).toBe(`my wallet ${"*".repeat(address.length)}`);
  });

  it("masks links, bare domains and messenger handles", () => {
    expect(maskContactDetails("https://evil.com/x")).toBe("******************");
    expect(maskContactDetails("www.scam.io")).toBe("***********");
    expect(maskContactDetails("go to scam.xyz now")).toBe("go to ******** now");
    expect(maskContactDetails("t.me/scam")).toBe("*********");
    expect(maskContactDetails("dm @alice123")).toBe("dm *********");
  });

  it("leaves plain sentences alone", () => {
    expect(maskContactDetails("selling 100 usdc on revolut")).toBe("selling 100 usdc on revolut");
  });

  it("masks phone numbers but not amounts and rates", () => {
    expect(maskContactDetails("zelle +1 (555) 010-0199")).toBe(`zelle ${"*".repeat(17)}`);
    expect(maskContactDetails("call 07700 900123")).toBe(`call ${"*".repeat(12)}`);
    expect(maskContactDetails("555.010.0199")).toBe("*".repeat(12));
    for (const text of ["Selling 1,606 USDC @ 0.7705 GBP on Wise!", "$100", "rates 0.77 0.78 0.79", "Selling 10000.00 USDC", "1.5 usdc"]) {
      expect(maskContactDetails(text)).toBe(text);
    }
  });

  it("masks domains with any TLD, including spaced and spelled-out dots", () => {
    expect(maskContactDetails("site example.cash")).toBe(`site ${"*".repeat(12)}`);
    expect(maskContactDetails("ens scammer.eth")).toBe(`ens ${"*".repeat(11)}`);
    expect(maskContactDetails("example [.] com")).toBe("*".repeat(15));
    expect(maskContactDetails("example (dot) net")).toBe("*".repeat(17));
    expect(maskContactDetails("example dot com")).toBe("*".repeat(15));
    expect(maskContactDetails("scam . com")).toBe("*".repeat(10));
    // Decimals, ellipses and ordinary sentence breaks are not domains.
    for (const text of ["rate is 0.7705", "ok... sure", "end. Next one"]) expect(maskContactDetails(text)).toBe(text);
  });

  it("masks emails, obfuscated links and bare addresses", () => {
    expect(maskContactDetails("bob@example.com")).toBe("*".repeat(15));
    expect(maskContactDetails("bob (at) gmail (dot) com")).toBe("*".repeat(24));
    expect(maskContactDetails("hxxps://evil.com")).toBe("*".repeat(16));
    const btc = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    expect(maskContactDetails(`btc ${btc}`)).toBe(`btc ${"*".repeat(btc.length)}`);
    expect(maskContactDetails("0x 1234 5678 9abc")).toBe("*".repeat(17));
  });

  it("masks spaced sigils and handles named next to a platform", () => {
    expect(maskContactDetails("pay $ alice")).toBe("pay *******");
    expect(maskContactDetails("dm @ alice")).toBe("dm *******");
    expect(maskContactDetails("venmo me bobsmith22")).toBe("venmo me **********");
    expect(maskContactDetails("venmo me bobsmith")).toBe("venmo me ********");
    expect(maskContactDetails("zelle bob1")).toBe("zelle ****");
    expect(maskContactDetails("tg: bob_1")).toBe("tg: *****");
    expect(maskContactDetails("discord bob#1234")).toBe("discord ********");
    expect(maskContactDetails("venmo @bob-smith")).toBe("venmo **********");
    expect(maskContactDetails("@alice123 @0.77")).toBe("********* @0.77");
    for (const text of ["meet @ the bank", "buying @ market rate", "venmo me now", "wise is down", "selling on wise at 0.77"]) {
      expect(maskContactDetails(text)).toBe(text);
    }
  });

  it("masks Discord invites, including bare gg/ codes, but not gg sign-offs", () => {
    expect(maskContactDetails("join discord gg/abcdef")).toBe(`join ${"*".repeat(17)}`);
    expect(maskContactDetails("gg/abcdef")).toBe("*".repeat(9));
    expect(maskContactDetails("GG / Abc123")).toBe("*".repeat(11));
    expect(maskContactDetails("discord.gg/abc")).toBe("*".repeat(14));
    expect(maskContactDetails("discordapp.com/invite/abc")).toBe("*".repeat(25));
    expect(maskContactDetails("discord . gg / abc")).toBe("*".repeat(18));
    for (const text of ["gg", "gg wp", "gg ez", "gg/wp all", "gg/ez", "discord community", "add me on discord later"]) {
      expect(maskContactDetails(text)).toBe(text);
    }
  });

  it("masks the word after a payment tag, keeping ordinary talk about tags", () => {
    expect(maskContactDetails("pay me on revolut revtag zezima")).toBe("pay me on revolut revtag ******");
    expect(maskContactDetails("my wisetag is bobsmith")).toBe("my wisetag is ********");
    expect(maskContactDetails("my wise tag is bobsmith")).toBe("my wise tag is ********");
    expect(maskContactDetails("cashtag bobsmith")).toBe("cashtag ********");
    expect(maskContactDetails("zelle tag: bob")).toBe("zelle tag: ***");
    expect(maskContactDetails("venmo tag bob")).toBe("venmo tag ***");
    expect(maskContactDetails("paytag bob")).toBe("paytag ***");
    expect(maskContactDetails("revolut tag @zezima")).toBe("revolut tag *******");
    for (const text of [
      "venmo is down",
      "wise is down",
      "revtag pls",
      "whats your revtag",
      "revtag?",
      "my cashtag is now changed",
      "my revtag is not set",
      "revtags are easy",
      "Selling on wise, tag me",
    ]) {
      expect(maskContactDetails(text)).toBe(text);
    }
  });

  it("sees through look-alike letters", () => {
    // Cyrillic о, а and с.
    expect(maskContactDetails("scam.c\u043em")).toBe("********");
    expect(maskContactDetails("sc\u0430m dot com")).toBe("*".repeat(12));
    expect(filterProfanity("fu\u0441k you")).toBe("**** you");
  });
});

describe("chat effects", () => {
  it("parses colour and motion prefixes in either order", () => {
    expect(parseEffects("red:wave:hello")).toEqual({ effects: { color: "red", motion: "wave" }, text: "hello" });
    expect(parseEffects("scroll:glow1:hi")).toEqual({ effects: { color: "glow1", motion: "scroll" }, text: "hi" });
    expect(parseEffects("note: this")).toEqual({ effects: { color: "yellow", motion: null }, text: "note: this" });
  });

  it("round-trips through encode/decode", () => {
    const effects = { color: "cyan", motion: "shake" } as const;
    expect(decodeEffects(encodeEffects(effects))).toEqual(effects);
    expect(encodeEffects({ color: "yellow", motion: null })).toBeNull();
    expect(decodeEffects(null)).toEqual({ color: "yellow", motion: null });
  });
});

describe("sanitiseChat", () => {
  it("returns null for empty or effect-only input", () => {
    expect(sanitiseChat("   ")).toBeNull();
    expect(sanitiseChat("wave:")).toBeNull();
    expect(sanitiseChat("\u0000\u0007")).toBeNull();
  });

  it("strips control characters, collapses whitespace and caps the length", () => {
    expect(sanitiseChat("hello\u0000world")).toEqual({ text: "helloworld", fx: null });
    expect(sanitiseChat("hello \u0007  world")).toEqual({ text: "hello world", fx: null });
    expect(sanitiseChat("a   b")).toEqual({ text: "a b", fx: null });
    expect(sanitiseChat("x".repeat(200))!.text).toHaveLength(80);
  });

  it("filters and masks after parsing effects", () => {
    expect(sanitiseChat("red:wave:fuck $alice")).toEqual({ text: "**** ******", fx: "red:wave" });
    expect(sanitiseChat("glow1:scroll:selling usdc")).toEqual({ text: "selling usdc", fx: "glow1:scroll" });
  });

  it("masks the audited bypasses (zero-width, bidi, full-width and look-alike characters)", () => {
    const address = `0x\u200b${"5".repeat(40)}`;
    const cases: Array<[string, string]> = [
      ["zelle +1 (555) 010-0199", `zelle ${"*".repeat(17)}`],
      ["call 07700 900123", `call ${"*".repeat(12)}`],
      [`addr ${address}`, `addr ${"*".repeat(42)}`],
      ["site example.cash", `site ${"*".repeat(12)}`],
      ["venmo me bobsmith22", "venmo me **********"],
      ["f\u200buck", "****"],
      ["\u202emoc.elpmaxe ta em dnif", `${"*".repeat(11)} ta em dnif`],
      ["evil\uff0ecom", "*".repeat(8)],
      ["t\u200b.me/scammer", "*".repeat(12)],
      ["s\u2060c\ufeffa\u200dm.c\u043em", "*".repeat(8)],
      ["s\u0338cam.com", "*".repeat(8)],
      ["f\u2800u\u2800c\u2800k", "* * * *"],
    ];
    for (const [input, expected] of cases) expect(sanitiseChat(input)?.text).toBe(expected);
  });

  it("keeps trade talk, place names and accented text", () => {
    for (const text of ["Selling 1,606 USDC @ 0.7705 GBP on Wise!", "$100", "Scunthorpe", "café crème", "\ud83d\ude00 hi"]) {
      expect(sanitiseChat(text)?.text).toBe(text);
    }
  });

  it("caps at 80 characters without splitting an emoji", () => {
    const text = sanitiseChat("\ud83d\ude00".repeat(100))!.text;
    expect([...text]).toHaveLength(80);
    expect(text).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
  });

  it("drops messages that are only invisible characters", () => {
    expect(sanitiseChat("\u200b\u200b\u202e")).toBeNull();
  });
});

describe("names", () => {
  it("accepts 1-12 letters, digits, spaces, hyphens and underscores", () => {
    expect(normaliseName("Zezima")).toBe("Zezima");
    expect(normaliseName("  Bob  ")).toBe("Bob");
    expect(normaliseName("bob_the-1")).toBe("bob_the-1");
    expect(normaliseName("a".repeat(13))).toBeNull();
    expect(normaliseName("B@b")).toBeNull();
    expect(normaliseName("_bob")).toBeNull();
  });

  it("rejects offensive and staff-like names", () => {
    expect(normaliseName("Shithead")).toBeNull();
    expect(normaliseName("Mod Bob")).toBeNull();
    expect(normaliseName("admin")).toBeNull();
    expect(normaliseName("Peer Bob")).toBeNull();
  });

  it("rejects names that impersonate staff, the bank, the protocol or the merchants", () => {
    const reserved = [
      "Mod_Ash", "ModAsh", "M0d Ash", "JMod", "PeerSupport", "Peer_Support", "Peerless", "Admin_", "Adm1n", "SiteAdmin",
      "Banker", "TheBanker", "Bank", "Teller", "Staff", "System", "Jagex", "Official", "RampRidge", "Ramp_Ridge",
      "News", "N3ws", "zkp2p", "Galleon", "Ga11eon", "GaIIeon", "Moderator", "Support", "Wise trader", "Venmo trader",
    ];
    for (const name of reserved) {
      expect(normaliseName(name), name).toBeNull();
      expect(isReservedName(name), name).toBe(true);
    }
    // Merchant NPCs are "<Platform> trader" (src/app/merchants.ts); shared/ cannot import src/peer/platforms.ts.
    const platforms = ["Venmo", "Cash App", "Revolut", "Wise", "Zelle", "PayPal", "Monzo", "Chime", "N26", "Luxon", "Mercado Pago", "Monobank Business", "X Money"];
    for (const platform of platforms) {
      for (const name of [`${platform} trader`, `${platform}trader`, `${platform.replace(/ /g, "")}_trader`]) {
        expect(isReservedName(name), name).toBe(true);
        expect(normaliseName(name), name).toBeNull();
      }
    }
    for (const name of ["Zezima", "Lynx", "Titan", "Bob", "bob_the-1", "Guest1234", "Durial321", "Newsboy"]) {
      expect(normaliseName(name), name).toBe(name);
    }
  });

  it("keys names case- and separator-insensitively", () => {
    expect(nameKey("Bob The-1")).toBe(nameKey("bob_the 1"));
    expect(nameKey("Guest1234")).toBe("guest1234");
  });
});
