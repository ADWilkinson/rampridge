/**
 * Interface sprites (cache index 8) and inventory item icons the UI draws,
 * written as PNGs with clear names plus public/game/sprites/manifest.json:
 *
 *   { "<name>": { file, w, h, offsetX, offsetY, canvasW, canvasH, id, frame } }
 *
 * w/h are the PNG size. offsetX/offsetY place the PNG inside the sprite's
 * canvas (canvasW x canvasH), exactly like the client's sprite offsets; most
 * interface pieces have zero offsets. Item icons are 36x32 with the client's
 * outline and inventory shadow baked in (id = item id, frame = quantity).
 * IDs come from RuneLite's gameval SpriteID table.
 */
import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import type { BakeCache } from "../lib/cache";
import { readInterface } from "../lib/interfaces";
import { ICON_HEIGHT, ICON_WIDTH, iconToArgb, renderItemIcon, renderModelSprite, renderNotedIcon } from "../lib/item-icons";
import { SPRITES_DIR, rel, writeIfChanged, writeJson } from "../lib/paths";
import { encodePng } from "../lib/png";
import { decodeSpriteGroup, framePng } from "../lib/sprite-decode";

/** [name, sprite group id, frame]. */
type Entry = readonly [string, number, number?];

const range = (prefix: string, names: string[], first: number): Entry[] => names.map((n, i) => [`${prefix}${n}`, first + i] as const);

export const SPRITES: readonly Entry[] = [
  // ---- chatbox ----
  ["chatbox_background", 1017],
  ["chatbox_buttons_background", 1018],
  ["chat_tab_button", 3051],
  ["chat_tab_button_hover", 3052],
  ["chat_tab_button_selected", 3053],
  ["chat_tab_button_selected_hover", 3054],
  ["chat_tab_button_new_messages", 3055],
  ["chat_report_button", 3057],
  ["chat_report_button_hover", 3058],

  // ---- side panel (fixed mode) ----
  ["side_background", 1031],
  ["side_background_bottom", 1032],
  ["side_background_left1", 1033],
  ["side_background_left2", 1034],
  ["side_background_right", 1035],
  ["side_background_top", 1036],
  ["tab_highlight_top_left", 1026],
  ["tab_highlight_top_right", 1027],
  ["tab_highlight_bottom_left", 1028],
  ["tab_highlight_bottom_right", 1029],
  ["tab_highlight_middle", 1030],
  // Fixed-mode side icons, as the fixed frame (interface 548) uses them.
  ["tab_icon_combat", 168],
  ...range(
    "tab_icon_",
    ["stats", "quests", "inventory", "equipment", "prayer", "magic", "clan_chat", "friends", "ignores", "logout", "settings", "emotes", "music"],
    898,
  ),
  ["tab_icon_account", 1709],

  // ---- fixed-mode frame around the viewport, minimap and side panel ----
  ["frame_main_top", 1039],
  ["frame_mini_left", 1037],
  ["frame_mini_right", 1038],
  ["frame_mini_top_right", 1441],
  ["frame_mini_bottom", 1611],
  ["frame_back_left", 4],

  // ---- stone borders (V2 interfaces and side panel) ----
  ...range(
    "stone_",
    [
      "side_edge_top",
      "side_edge_left",
      "side_edge_bottom",
      "side_edge_right",
      "side_corner_top_left",
      "side_corner_top_right",
      "side_corner_bottom_left",
      "side_corner_bottom_right",
      "side_edge_horizontal",
      "side_intersection_left",
      "side_intersection_right",
    ],
    820,
  ),
  ...range(
    "stone_",
    [
      "side_intersection_bottom",
      "side_intersection_top",
      "edge_vertical",
      "intersection_top",
      "intersection_bottom",
      "intersection_left",
      "intersection_right",
      "corner_top_left",
      "corner_top_right",
      "corner_bottom_left",
      "corner_bottom_right",
      "intersection_middle",
    ],
    839,
  ),
  ["stone_close_button", 831],
  ["stone_close_button_hover", 832],
  ...range("stone_button_", ["top_left", "top_right", "bottom_left", "bottom_right", "left", "top", "right", "bottom"], 913),

  // ---- minimap ----
  ["minimap_background", 12],
  ["minimap_frame", 1182],
  ["minimap_mask", 1183],
  ["compass_mask", 1184],
  ["minimap_clickmask", 1200],
  ["compass", 169],
  ["mapdot_item", 300, 0],
  ["mapdot_npc", 300, 1],
  ["mapdot_player", 300, 2],
  ["mapdot_friend", 300, 3],
  ["mapdot_team", 300, 4],
  ["mapdot_clan", 300, 5],
  ["map_marker", 422],

  // ---- orbs ----
  ["orb_frame", 1071],
  ["orb_frame_hover", 1072],
  ["orb_fill_empty", 1059],
  ["orb_fill_hitpoints", 1060],
  ["orb_fill_prayer", 1063],
  ["orb_fill_run", 1064],
  ["orb_fill_run_active", 1065],
  ["orb_fill_prayer_active", 1066],
  ["orb_fill_special", 1607],
  ["orb_fill_special_active", 1608],
  ["orb_icon_hitpoints", 1067],
  ["orb_icon_prayer", 1068],
  ["orb_icon_walk", 1069],
  ["orb_icon_run", 1070],
  ["orb_icon_special", 1610],

  // ---- click crosses (in-world) ----
  ["cross_yellow_1", 299, 0],
  ["cross_yellow_2", 299, 1],
  ["cross_yellow_3", 299, 2],
  ["cross_yellow_4", 299, 3],
  ["cross_red_1", 299, 4],
  ["cross_red_2", 299, 5],
  ["cross_red_3", 299, 6],
  ["cross_red_4", 299, 7],

  // ---- generic interface pieces ----
  ["interface_background", 297],
  ["interface_background_dark", 897],
  ["interface_background_light", 1040],
  ["interface_background_beige", 1545],
  ["steel_border_top_left", 310],
  ["steel_border_top_right", 311],
  ["steel_border_bottom_left", 312],
  ["steel_border_bottom_right", 313],
  ["steel_border_top", 314],
  ["steel_border_right", 315],
  ["close_button", 535],
  ["close_button_hover", 536],
  ["close_button_parchment", 537],
  ["close_button_parchment_hover", 538],
  ["close_button_red", 539],
  ["close_button_red_hover", 540],
  ["close_button_v2", 799],
  ["close_button_v2_hover", 800],
  ...range("button_tile_grey_", ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"], 1141),
  ...range("button_tile_red_", ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"], 1150),
  ["button_middle_grey", 1048],
  ["button_middle_red", 1049],
  ["button_brown", 428],
  ["button_red", 429],
  ["button_brown_big", 438],
  ["button_brown_small", 2248],
  ["tab_slanted", 952],
  ["tab_slanted_hover", 953],
  ["arrow_left", 308],
  ["arrow_right", 309],
  ["arrow_left_small", 425],
  ["arrow_right_small", 426],
  ["checkbox_empty", 1215],
  ["checkbox_crossed", 1216],
  ["checkbox_checked", 1217],
  ["checkbox_hover", 1218],
  ["checkbox_crossed_hover", 1219],
  ["checkbox_checked_hover", 1220],
  ...range("slider_", ["1_of_4", "2_of_4", "3_of_4", "4_of_4", "thumb_1_of_4", "thumb_2_of_4", "thumb_3_of_4", "thumb_4_of_4"], 679),
  ["slider_bobble", 1201],
  ["tick", 1210],
  ["info", 1236],
  ["exclamation_mark", 937],

  // ---- scrollbars ----
  ["scrollbar_up", 773],
  ["scrollbar_down", 788],
  ["scrollbar_thumb_top", 789],
  ["scrollbar_thumb_middle", 790],
  ["scrollbar_thumb_bottom", 791],
  ["scrollbar_track", 792],
  ["scrollbar_parchment_up", 793],
  ["scrollbar_parchment_down", 794],
  ["scrollbar_parchment_thumb_top", 795],
  ["scrollbar_parchment_thumb_middle", 796],
  ["scrollbar_parchment_thumb_bottom", 797],
  ["scrollbar_parchment_track", 798],

  // ---- bank ----
  ["bank_deposit_inventory", 1041],
  ["bank_deposit_equipment", 1042],
  ["bank_search", 1043],
  ["bank_placeholders", 1342],
  ["bank_tab", 1077],
  ["bank_tab_hover", 1078],
  ["bank_tab_selected", 1079],
  ["bank_tab_empty", 1080],
  ["bank_tab_icon_all", 1081],
  ["bank_tab_icon_add", 1082],
  ["bank_arrow_green", 2496],
  ["bank_mode_insert", 2820],
  ["bank_mode_swap", 2821],
  ["bank_withdraw_note", 2822],
  ["slot_tile", 170],
  ["iron_rivets_square", 171],
  ["iron_rivets_vertical", 172],
  ["iron_rivets_horizontal", 173],

  // ---- Grand Exchange ----
  ["ge_offer_sell", 1106],
  ["ge_offer_sell_hover", 1107],
  ["ge_offer_buy", 1108],
  ["ge_offer_buy_hover", 1109],
  ["ge_button", 1110],
  ["ge_button_hover", 1111],
  ["ge_guide_price", 1112],
  ["ge_search", 1113],
  ["ge_decrement_fast", 1114],
  ["ge_increment_fast", 1115],
  ["ge_decrement", 1116],
  ["ge_increment", 1117],
  ["ge_collect_buy", 1118],
  ["ge_collect_sell", 1119],
  ["ge_item_backdrop", 1120],
  ["ge_item_backdrop_glow", 1121],
  ["ge_back", 1122],
  ["ge_text_left", 1123],
  ["ge_text_middle", 1124],
  ["ge_text_right", 1125],
  ["ge_cancel", 1126],
  ["ge_cancel_hover", 1127],

  // ---- emotes tab ----
  ["emote_yes", 700],
  ["emote_no", 701],
  ["emote_think", 702],
  ["emote_bow", 703],
  ["emote_angry", 704],
  ["emote_cry", 705],
  ["emote_laugh", 706],
  ["emote_cheer", 707],
  ["emote_wave", 708],
  ["emote_beckon", 709],
  ["emote_dance", 710],
  ["emote_clap", 711],
  ["emote_jump", 716],
  ["emote_shrug", 720],

  // ---- title / login screen ----
  ["title_box", 499],
  ["title_button", 500],
  ["title_button_large", 1649],
  ["title_button_wide", 2135],
  ["title_mute", 811],

  // ---- chat icons ----
  ["mod_icon_moderator", 423, 0],
  ["mod_icon_admin", 423, 1],
];

/** Inventory icons: [name, item id, quantity] or a bank note of an item. */
type ItemEntry =
  | { name: string; id: number; quantity: number }
  | { name: string; noteOf: number; template: number };

/** Coin stack sizes at which the client switches coin models (ObjType 995 countco). */
export const COIN_STACKS = [1, 2, 3, 4, 5, 25, 100, 250, 1000, 10000] as const;
const NOTE_TEMPLATE = 799;

export const ITEMS: readonly ItemEntry[] = [
  ...COIN_STACKS.map((q) => ({ name: `item_coins_${q}`, id: 995, quantity: q })),
  { name: "item_bank_note", noteOf: 995, template: NOTE_TEMPLATE },
  { name: "item_note_blank", id: NOTE_TEMPLATE, quantity: 1 },
  { name: "item_clue_scroll", id: 2677, quantity: 1 },
  { name: "item_ring_of_wealth", id: 2572, quantity: 1 },
  { name: "item_gold_ring", id: 1635, quantity: 1 },
  { name: "item_partyhat_red", id: 1038, quantity: 1 },
  { name: "item_partyhat_yellow", id: 1040, quantity: 1 },
  { name: "item_partyhat_blue", id: 1042, quantity: 1 },
  { name: "item_partyhat_green", id: 1044, quantity: 1 },
  { name: "item_partyhat_purple", id: 1046, quantity: 1 },
  { name: "item_partyhat_white", id: 1048, quantity: 1 },
  { name: "item_amulet_of_glory", id: 1712, quantity: 1 },
];

export interface SpriteManifestEntry {
  file: string;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  canvasW: number;
  canvasH: number;
  id: number;
  frame: number;
  /** Text area inside the PNG, for artwork that frames content (the parchment scroll). */
  content?: { x: number; y: number; w: number; h: number };
}

/** Clue scroll interface: component 0 is the parchment model, component 2 the text box. */
const SCROLL_INTERFACE = 203;
/** Fixed-mode viewport the interface is laid out in. */
const VIEWPORT = { width: 512, height: 334 };

export async function bakeSprites(cache: BakeCache): Promise<Record<string, SpriteManifestEntry>> {
  const manifest: Record<string, SpriteManifestEntry> = {};
  const groups = new Map<number, ReturnType<typeof decodeSpriteGroup>>();
  const written = new Set<string>();
  const put = (name: string, png: Buffer, entry: Omit<SpriteManifestEntry, "file">) => {
    if (manifest[name]) throw new Error(`duplicate sprite name ${name}`);
    const file = `${name}.png`;
    writeIfChanged(path.join(SPRITES_DIR, file), png);
    written.add(file);
    manifest[name] = { file, ...entry };
  };

  for (const [name, id, frameIndex = 0] of SPRITES) {
    let frames = groups.get(id);
    if (!frames) {
      frames = decodeSpriteGroup(cache, id);
      groups.set(id, frames);
    }
    const frame = frames[frameIndex];
    if (!frame) throw new Error(`sprite ${name}: group ${id} has no frame ${frameIndex}`);
    if (frame.width === 0 || frame.height === 0) throw new Error(`sprite ${name}: group ${id} frame ${frameIndex} is empty`);
    put(name, framePng(frame), {
      w: frame.width,
      h: frame.height,
      offsetX: frame.offsetX,
      offsetY: frame.offsetY,
      canvasW: frame.canvasWidth,
      canvasH: frame.canvasHeight,
      id,
      frame: frameIndex,
    });
  }

  for (const item of ITEMS) {
    const px = "noteOf" in item ? renderNotedIcon(cache, item.noteOf, item.template) : renderItemIcon(cache, item.id, item.quantity);
    const argb = iconToArgb(px);
    const png = new PNG({ width: ICON_WIDTH, height: ICON_HEIGHT });
    for (let i = 0; i < argb.length; i++) {
      const c = argb[i]!;
      png.data[i * 4] = (c >>> 16) & 0xff;
      png.data[i * 4 + 1] = (c >>> 8) & 0xff;
      png.data[i * 4 + 2] = c & 0xff;
      png.data[i * 4 + 3] = (c >>> 24) & 0xff;
    }
    put(item.name, encodePng(png), {
      w: ICON_WIDTH,
      h: ICON_HEIGHT,
      offsetX: 0,
      offsetY: 0,
      canvasW: ICON_WIDTH,
      canvasH: ICON_HEIGHT,
      id: "noteOf" in item ? item.noteOf : item.id,
      frame: "noteOf" in item ? 0 : item.quantity,
    });
  }

  // Parchment: the clue scroll interface draws a 3D scroll model, so render it like the client.
  {
    const comps = readInterface(cache, SCROLL_INTERFACE);
    const modelComp = comps.find((c) => c.model);
    const text = comps.find((c) => c.type === 4);
    if (!modelComp?.model || !text) throw new Error(`interface ${SCROLL_INTERFACE} layout changed`);
    const m = modelComp.model;
    const data = cache.factory.getModelLoader().getModel(m.id);
    if (!data) throw new Error(`scroll model ${m.id} missing`);
    const model = data.light(cache.factory.getTextureLoader(), 64, 768, -50, -10, -50);
    const px = renderModelSprite(cache, model, {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      centerX: modelComp.x + (modelComp.width >> 1),
      centerY: modelComp.y + (modelComp.height >> 1),
      xan: m.xan,
      yan: m.yan,
      zan: m.zan,
      zoom: m.zoom,
      offsetX: m.offsetX,
      offsetY: m.offsetY,
    });
    let x0 = VIEWPORT.width, y0 = VIEWPORT.height, x1 = -1, y1 = -1;
    for (let y = 0; y < VIEWPORT.height; y++) {
      for (let x = 0; x < VIEWPORT.width; x++) {
        if (px[y * VIEWPORT.width + x] === 0) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = px[(y + y0) * VIEWPORT.width + x + x0]!;
        const o = (y * w + x) * 4;
        png.data[o] = (c >>> 16) & 0xff;
        png.data[o + 1] = (c >>> 8) & 0xff;
        png.data[o + 2] = c & 0xff;
        png.data[o + 3] = c === 0 ? 0 : 0xff;
      }
    }
    put("parchment_scroll", encodePng(png), {
      w,
      h,
      offsetX: x0,
      offsetY: y0,
      canvasW: VIEWPORT.width,
      canvasH: VIEWPORT.height,
      id: m.id,
      frame: 0,
      content: { x: text.x - x0, y: text.y - y0, w: text.width, h: text.height },
    });
  }

  // The directory is owned by this step: drop files from earlier bakes (incl. the research seed).
  for (const f of fs.readdirSync(SPRITES_DIR)) {
    if (f !== "manifest.json" && !written.has(f)) fs.rmSync(path.join(SPRITES_DIR, f));
  }
  writeJson(path.join(SPRITES_DIR, "manifest.json"), manifest);
  console.log(`  sprites: ${SPRITES.length} interface + ${ITEMS.length} item icons -> ${rel(SPRITES_DIR)}`);
  return manifest;
}
