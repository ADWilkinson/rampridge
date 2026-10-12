/**
 * Interface sprites used by the UI kit, named for what they are in the
 * interface. Each entry is keyed three ways so the bake (scripts/bake) and the
 * kit agree without sharing code:
 *  - `id`/`frame`: cache sprite archive and frame (for items: item id and the
 *    stack size the icon was rendered for),
 *  - `rl`: the RuneLite `net.runelite.api.gameval.SpriteID` name (items:
 *    `ItemID`),
 *  - `bake`: the entry name in public/game/sprites/manifest.json, when the
 *    bake exports it.
 *
 * Geometry is the exported image: `w`/`h` trimmed size, `ox`/`oy` its offset
 * inside the `mw` x `mh` canvas; `avg` is the average opaque colour, used as
 * the fallback fill when the file is missing. Pure data: safe in Node.
 */

export interface SpriteDef {
  /** Sprite archive id (index 8), or the item id for item icons. */
  id: number;
  /** Frame within the archive (default 0); the stack size for item icons. */
  frame?: number;
  /** RuneLite SpriteID / ItemID name. */
  rl: string;
  /** Name in the bake's manifest, when exported. */
  bake?: string;
  w: number;
  h: number;
  ox: number;
  oy: number;
  mw: number;
  mh: number;
  /** Average opaque colour, the fallback fill. */
  avg: string;
}

export const SPRITES = {
  tradeBacking: { id: 297, rl: "TRADEBACKING", bake: "interface_background", w: 88, h: 60, ox: 0, oy: 0, mw: 88, mh: 60, avg: "#483e33" },
  stoneTop: { id: 820, rl: "V2StoneBorders._0", bake: "stone_side_edge_top", w: 32, h: 7, ox: 0, oy: 13, mw: 32, mh: 32, avg: "#484234" },
  stoneLeft: { id: 821, rl: "V2StoneBorders._1", bake: "stone_side_edge_left", w: 7, h: 32, ox: 13, oy: 0, mw: 32, mh: 32, avg: "#484234" },
  stoneBottom: { id: 822, rl: "V2StoneBorders._2", bake: "stone_side_edge_bottom", w: 32, h: 7, ox: 0, oy: 13, mw: 32, mh: 32, avg: "#504a3c" },
  stoneRight: { id: 823, rl: "V2StoneBorders._3", bake: "stone_side_edge_right", w: 7, h: 32, ox: 13, oy: 0, mw: 32, mh: 32, avg: "#504a3c" },
  stoneTopLeft: { id: 824, rl: "V2StoneBorders._4", bake: "stone_side_corner_top_left", w: 32, h: 32, ox: 0, oy: 0, mw: 32, mh: 32, avg: "#4c4638" },
  stoneTopRight: { id: 825, rl: "V2StoneBorders._5", bake: "stone_side_corner_top_right", w: 32, h: 32, ox: 0, oy: 0, mw: 32, mh: 32, avg: "#4d4739" },
  stoneBottomLeft: { id: 826, rl: "V2StoneBorders._6", bake: "stone_side_corner_bottom_left", w: 32, h: 32, ox: 0, oy: 0, mw: 32, mh: 32, avg: "#4f493b" },
  stoneBottomRight: { id: 827, rl: "V2StoneBorders._7", bake: "stone_side_corner_bottom_right", w: 32, h: 32, ox: 0, oy: 0, mw: 32, mh: 32, avg: "#504a3c" },
  stoneDivider: { id: 828, rl: "V2StoneBorders._8", bake: "stone_side_edge_horizontal", w: 32, h: 6, ox: 0, oy: 14, mw: 32, mh: 32, avg: "#554e3d" },
  stoneDividerLeft: { id: 829, rl: "V2StoneBorders._9", bake: "stone_side_intersection_left", w: 11, h: 12, ox: 0, oy: 9, mw: 32, mh: 32, avg: "#4d4738" },
  stoneDividerRight: { id: 830, rl: "V2StoneBorders._10", bake: "stone_side_intersection_right", w: 11, h: 12, ox: 21, oy: 9, mw: 32, mh: 32, avg: "#514a3c" },
  steelTopLeft: { id: 310, rl: "Steelborder._0", bake: "steel_border_top_left", w: 25, h: 30, ox: 0, oy: 0, mw: 25, mh: 30, avg: "#252522" },
  steelTopRight: { id: 311, rl: "Steelborder._1", bake: "steel_border_top_right", w: 25, h: 30, ox: 0, oy: 0, mw: 25, mh: 30, avg: "#252522" },
  steelBottomLeft: { id: 312, rl: "Steelborder._2", bake: "steel_border_bottom_left", w: 25, h: 30, ox: 0, oy: 0, mw: 25, mh: 30, avg: "#252522" },
  steelBottomRight: { id: 313, rl: "Steelborder._3", bake: "steel_border_bottom_right", w: 25, h: 30, ox: 0, oy: 0, mw: 25, mh: 30, avg: "#252522" },
  steelHorizontal: { id: 314, rl: "Steelborder2._0", bake: "steel_border_top", w: 36, h: 6, ox: 0, oy: 15, mw: 36, mh: 36, avg: "#262623" },
  steelVertical: { id: 315, rl: "Steelborder2._1", bake: "steel_border_right", w: 6, h: 36, ox: 15, oy: 0, mw: 36, mh: 36, avg: "#262623" },
  closeButton: { id: 535, rl: "CloseButtons._0", bake: "close_button", w: 21, h: 21, ox: 1, oy: 1, mw: 26, mh: 23, avg: "#453b2c" },
  closeButtonHover: { id: 536, rl: "CloseButtons._1", bake: "close_button_hover", w: 21, h: 21, ox: 1, oy: 1, mw: 26, mh: 23, avg: "#41382a" },
  buttonGreyNW: { id: 1141, rl: "MISCGRAPHICS_BUTTONTILE_NW_GREY", bake: "button_tile_grey_nw", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#49443a" },
  buttonGreyN: { id: 1142, rl: "MISCGRAPHICS_BUTTONTILE_NC_GREY", bake: "button_tile_grey_n", w: 12, h: 6, ox: 0, oy: 0, mw: 12, mh: 6, avg: "#4d4943" },
  buttonGreyNE: { id: 1143, rl: "MISCGRAPHICS_BUTTONTILE_NE_GREY", bake: "button_tile_grey_ne", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#4c473d" },
  buttonGreyW: { id: 1144, rl: "MISCGRAPHICS_BUTTONTILE_CW_GREY", bake: "button_tile_grey_w", w: 6, h: 12, ox: 0, oy: 0, mw: 6, mh: 12, avg: "#4d4a44" },
  buttonGreyC: { id: 1145, rl: "MISCGRAPHICS_BUTTONTILE_CC_GREY", bake: "button_tile_grey_c", w: 12, h: 12, ox: 0, oy: 0, mw: 12, mh: 12, avg: "#50504c" },
  buttonGreyE: { id: 1146, rl: "MISCGRAPHICS_BUTTONTILE_CE_GREY", bake: "button_tile_grey_e", w: 6, h: 12, ox: 0, oy: 0, mw: 6, mh: 12, avg: "#4e4b44" },
  buttonGreySW: { id: 1147, rl: "MISCGRAPHICS_BUTTONTILE_SW_GREY", bake: "button_tile_grey_sw", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#4d483e" },
  buttonGreyS: { id: 1148, rl: "MISCGRAPHICS_BUTTONTILE_SC_GREY", bake: "button_tile_grey_s", w: 12, h: 6, ox: 0, oy: 0, mw: 12, mh: 6, avg: "#504e47" },
  buttonGreySE: { id: 1149, rl: "MISCGRAPHICS_BUTTONTILE_SE_GREY", bake: "button_tile_grey_se", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#4b463c" },
  buttonRedNW: { id: 1150, rl: "MISCGRAPHICS_BUTTONTILE_NW_RED", bake: "button_tile_red_nw", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#6f1a18" },
  buttonRedN: { id: 1151, rl: "MISCGRAPHICS_BUTTONTILE_NC_RED", bake: "button_tile_red_n", w: 12, h: 6, ox: 0, oy: 0, mw: 12, mh: 6, avg: "#771c1a" },
  buttonRedNE: { id: 1152, rl: "MISCGRAPHICS_BUTTONTILE_NE_RED", bake: "button_tile_red_ne", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#731b19" },
  buttonRedW: { id: 1153, rl: "MISCGRAPHICS_BUTTONTILE_CW_RED", bake: "button_tile_red_w", w: 6, h: 12, ox: 0, oy: 0, mw: 6, mh: 12, avg: "#781c1a" },
  buttonRedC: { id: 1154, rl: "MISCGRAPHICS_BUTTONTILE_CC_RED", bake: "button_tile_red_c", w: 12, h: 12, ox: 0, oy: 0, mw: 12, mh: 12, avg: "#811e1c" },
  buttonRedE: { id: 1155, rl: "MISCGRAPHICS_BUTTONTILE_CE_RED", bake: "button_tile_red_e", w: 6, h: 12, ox: 0, oy: 0, mw: 6, mh: 12, avg: "#791c1a" },
  buttonRedSW: { id: 1156, rl: "MISCGRAPHICS_BUTTONTILE_SW_RED", bake: "button_tile_red_sw", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#731b19" },
  buttonRedS: { id: 1157, rl: "MISCGRAPHICS_BUTTONTILE_SC_RED", bake: "button_tile_red_s", w: 12, h: 6, ox: 0, oy: 0, mw: 12, mh: 6, avg: "#7d1d1b" },
  buttonRedSE: { id: 1158, rl: "MISCGRAPHICS_BUTTONTILE_SE_RED", bake: "button_tile_red_se", w: 6, h: 6, ox: 0, oy: 0, mw: 6, mh: 6, avg: "#711a18" },
  arrowLeft: { id: 308, rl: "LEFTARROW", bake: "arrow_left", w: 43, h: 29, ox: 1, oy: 4, mw: 45, mh: 36, avg: "#676159" },
  arrowRight: { id: 309, rl: "RIGHTARROW", bake: "arrow_right", w: 43, h: 29, ox: 1, oy: 4, mw: 45, mh: 36, avg: "#676159" },
  arrowLeftHover: { id: 2385, rl: "LEFTARROW_HIGHLIGHT", w: 43, h: 29, ox: 1, oy: 4, mw: 45, mh: 36, avg: "#7b756d" },
  arrowRightHover: { id: 2389, rl: "RIGHTARROW_HIGHLIGHT", w: 43, h: 29, ox: 1, oy: 4, mw: 45, mh: 36, avg: "#7b756d" },
  titleBox: { id: 499, rl: "TITLEBOX", bake: "title_box", w: 360, h: 200, ox: 0, oy: 0, mw: 360, mh: 200, avg: "#3f4049" },
  titleButton: { id: 500, rl: "TITLEBUTTON", bake: "title_button", w: 147, h: 41, ox: 0, oy: 0, mw: 147, mh: 41, avg: "#34353d" },
  scrollUp: { id: 773, rl: "ScrollbarV2._0", bake: "scrollbar_up", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#42392a" },
  scrollDown: { id: 788, rl: "ScrollbarV2._1", bake: "scrollbar_down", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#42392b" },
  scrollThumbTop: { id: 789, rl: "ScrollbarDraggerV2._0", bake: "scrollbar_thumb_top", w: 16, h: 5, ox: 0, oy: 0, mw: 16, mh: 5, avg: "#483f2e" },
  scrollThumbMiddle: { id: 790, rl: "ScrollbarDraggerV2._1", bake: "scrollbar_thumb_middle", w: 16, h: 5, ox: 0, oy: 0, mw: 16, mh: 5, avg: "#554a37" },
  scrollThumbBottom: { id: 791, rl: "ScrollbarDraggerV2._2", bake: "scrollbar_thumb_bottom", w: 16, h: 5, ox: 0, oy: 0, mw: 16, mh: 5, avg: "#3b3426" },
  scrollTrack: { id: 792, rl: "ScrollbarDraggerV2._3", bake: "scrollbar_track", w: 16, h: 5, ox: 0, oy: 0, mw: 16, mh: 5, avg: "#262019" },
  parchmentScrollUp: { id: 793, rl: "ScrollbarParchmentV2._0", bake: "scrollbar_parchment_up", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#91774f" },
  parchmentScrollDown: { id: 794, rl: "ScrollbarParchmentV2._1", bake: "scrollbar_parchment_down", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#816841" },
  parchmentThumbTop: { id: 795, rl: "ScrollbarParchmentDraggerV2._0", bake: "scrollbar_parchment_thumb_top", w: 14, h: 5, ox: 1, oy: 0, mw: 16, mh: 5, avg: "#6e5735" },
  parchmentThumbMiddle: { id: 796, rl: "ScrollbarParchmentDraggerV2._1", bake: "scrollbar_parchment_thumb_middle", w: 14, h: 5, ox: 1, oy: 0, mw: 16, mh: 5, avg: "#6d5634" },
  parchmentThumbBottom: { id: 797, rl: "ScrollbarParchmentDraggerV2._2", bake: "scrollbar_parchment_thumb_bottom", w: 14, h: 5, ox: 1, oy: 0, mw: 16, mh: 5, avg: "#6e5735" },
  parchmentTrack: { id: 798, rl: "ScrollbarParchmentDraggerV2._3", bake: "scrollbar_parchment_track", w: 16, h: 5, ox: 0, oy: 0, mw: 16, mh: 5, avg: "#95794f" },
  tab: { id: 952, rl: "Tabs._0", bake: "tab_slanted", w: 79, h: 20, ox: 0, oy: 0, mw: 79, mh: 20, avg: "#585142" },
  tabActive: { id: 953, rl: "Tabs._1", bake: "tab_slanted_hover", w: 79, h: 20, ox: 0, oy: 0, mw: 79, mh: 20, avg: "#484235" },
  chatBackground: { id: 1017, rl: "CHAT_BACKGROUND", bake: "chatbox_background", w: 519, h: 142, ox: 0, oy: 0, mw: 519, mh: 142, avg: "#b0a183" },
  chatButtonsBar: { id: 1018, rl: "MAIN_STONES_BOTTOM", bake: "chatbox_buttons_background", w: 519, h: 23, ox: 0, oy: 0, mw: 519, mh: 23, avg: "#221a13" },
  chatTab: { id: 3051, rl: "ChatTabButton._0", bake: "chat_tab_button", w: 56, h: 22, ox: 0, oy: 0, mw: 56, mh: 22, avg: "#4b4339" },
  chatTabHover: { id: 3052, rl: "ChatTabButton._1", bake: "chat_tab_button_hover", w: 56, h: 22, ox: 0, oy: 0, mw: 56, mh: 22, avg: "#846946" },
  chatTabSelected: { id: 3053, rl: "ChatTabButton._2", bake: "chat_tab_button_selected", w: 56, h: 22, ox: 0, oy: 0, mw: 56, mh: 22, avg: "#483a28" },
  chatTabSelectedHover: { id: 3054, rl: "ChatTabButton._3", bake: "chat_tab_button_selected_hover", w: 56, h: 22, ox: 0, oy: 0, mw: 56, mh: 22, avg: "#7f6944" },
  sideBackground: { id: 1031, rl: "SIDE_BACKGROUND", bake: "side_background", w: 190, h: 261, ox: 0, oy: 0, mw: 190, mh: 261, avg: "#463d34" },
  sideBottom: { id: 1032, rl: "SIDE_BACKGROUND_BOTTOM", bake: "side_background_bottom", w: 246, h: 37, ox: 0, oy: 0, mw: 246, mh: 37, avg: "#474138" },
  sideLeftTop: { id: 1033, rl: "SIDE_BACKGROUND_LEFT1", bake: "side_background_left1", w: 31, h: 133, ox: 0, oy: 0, mw: 31, mh: 133, avg: "#443c30" },
  sideLeftBottom: { id: 1034, rl: "SIDE_BACKGROUND_LEFT2", bake: "side_background_left2", w: 28, h: 128, ox: 0, oy: 0, mw: 28, mh: 128, avg: "#3a342a" },
  sideRight: { id: 1035, rl: "SIDE_BACKGROUND_RIGHT", bake: "side_background_right", w: 28, h: 261, ox: 0, oy: 0, mw: 28, mh: 261, avg: "#3f392e" },
  sideTop: { id: 1036, rl: "SIDE_BACKGROUND_TOP", bake: "side_background_top", w: 249, h: 38, ox: 0, oy: 0, mw: 249, mh: 38, avg: "#484239" },
  sideHighlightTopLeft: { id: 1026, rl: "SideStoneHighlights._0", bake: "tab_highlight_top_left", w: 38, h: 36, ox: 0, oy: 0, mw: 38, mh: 36, avg: "#3f1510" },
  sideHighlightTopRight: { id: 1027, rl: "SideStoneHighlights._1", bake: "tab_highlight_top_right", w: 38, h: 36, ox: 0, oy: 0, mw: 38, mh: 36, avg: "#401510" },
  sideHighlightBottomLeft: { id: 1028, rl: "SideStoneHighlights._2", bake: "tab_highlight_bottom_left", w: 38, h: 36, ox: 0, oy: 0, mw: 38, mh: 36, avg: "#3d1410" },
  sideHighlightBottomRight: { id: 1029, rl: "SideStoneHighlights._3", bake: "tab_highlight_bottom_right", w: 38, h: 36, ox: 0, oy: 0, mw: 38, mh: 36, avg: "#421611" },
  sideHighlightMiddle: { id: 1030, rl: "SideStoneHighlights._4", bake: "tab_highlight_middle", w: 33, h: 36, ox: 0, oy: 0, mw: 38, mh: 36, avg: "#3e1510" },
  tabIconInventory: { id: 900, rl: "SideIcons._3", bake: "tab_icon_inventory", w: 26, h: 28, ox: 4, oy: 4, mw: 33, mh: 36, avg: "#482c12" },
  tabIconLogout: { id: 907, rl: "SideIcons._10", bake: "tab_icon_logout", w: 21, h: 30, ox: 6, oy: 3, mw: 33, mh: 36, avg: "#745d46" },
  tabIconSettings: { id: 908, rl: "SideIcons._11", bake: "tab_icon_settings", w: 24, h: 24, ox: 5, oy: 6, mw: 33, mh: 36, avg: "#433e38" },
  tabIconEmotes: { id: 909, rl: "SideIcons._12", bake: "tab_icon_emotes", w: 19, h: 28, ox: 7, oy: 4, mw: 33, mh: 36, avg: "#2f291a" },
  tabIconAccount: { id: 1709, rl: "SideIcons._22", bake: "tab_icon_account", w: 28, h: 28, ox: 3, oy: 5, mw: 33, mh: 36, avg: "#56452e" },
  // The original tabs RampRidge leaves out, drawn dimmed on their stones (SidePanel SIDE_DECOR).
  tabIconCombat: { id: 168, rl: "(bake) tab_icon_combat", bake: "tab_icon_combat", w: 20, h: 20, ox: 7, oy: 8, mw: 33, mh: 36, avg: "#6c6355" },
  tabIconStats: { id: 898, rl: "SideIcons._1", bake: "tab_icon_stats", w: 25, h: 23, ox: 4, oy: 7, mw: 33, mh: 36, avg: "#3f3e35" },
  tabIconQuests: { id: 899, rl: "SideIcons._2", bake: "tab_icon_quests", w: 22, h: 22, ox: 6, oy: 7, mw: 33, mh: 36, avg: "#878aac" },
  tabIconEquipment: { id: 901, rl: "SideIcons._4", bake: "tab_icon_equipment", w: 27, h: 32, ox: 3, oy: 2, mw: 33, mh: 36, avg: "#443f39" },
  tabIconPrayer: { id: 902, rl: "SideIcons._5", bake: "tab_icon_prayer", w: 26, h: 30, ox: 4, oy: 3, mw: 33, mh: 36, avg: "#7a887d" },
  tabIconMagic: { id: 903, rl: "SideIcons._6", bake: "tab_icon_magic", w: 25, h: 24, ox: 4, oy: 6, mw: 33, mh: 36, avg: "#66523b" },
  tabIconClanChat: { id: 904, rl: "SideIcons._7", bake: "tab_icon_clan_chat", w: 23, h: 27, ox: 5, oy: 5, mw: 33, mh: 36, avg: "#52431e" },
  tabIconFriends: { id: 905, rl: "SideIcons._8", bake: "tab_icon_friends", w: 23, h: 23, ox: 5, oy: 7, mw: 33, mh: 36, avg: "#ac7717" },
  tabIconIgnores: { id: 906, rl: "SideIcons._9", bake: "tab_icon_ignores", w: 23, h: 23, ox: 5, oy: 7, mw: 33, mh: 36, avg: "#9b2115" },
  tabIconMusic: { id: 910, rl: "SideIcons._13", bake: "tab_icon_music", w: 22, h: 26, ox: 5, oy: 5, mw: 33, mh: 36, avg: "#41341b" },
  minimapFrame: { id: 1182, rl: "FIXED_MINIMAP_COVER", bake: "minimap_frame", w: 172, h: 156, ox: 0, oy: 0, mw: 172, mh: 156, avg: "#39342c" },
  minimapMask: { id: 1183, rl: "FIXED_MAP_MASK", bake: "minimap_mask", w: 145, h: 151, ox: 0, oy: 0, mw: 145, mh: 151, avg: "#000001" },
  compassMask: { id: 1184, rl: "FIXED_COMPASS_MASK", bake: "compass_mask", w: 32, h: 33, ox: 0, oy: 0, mw: 32, mh: 33, avg: "#000001" },
  compass: { id: 169, rl: "COMPASS", bake: "compass", w: 51, h: 51, ox: 0, oy: 0, mw: 51, mh: 51, avg: "#5a5141" },
  orbFrame: { id: 1071, rl: "OrbFrame._0", bake: "orb_frame", w: 57, h: 34, ox: 0, oy: 0, mw: 57, mh: 34, avg: "#3a332b" },
  orbFrameHover: { id: 1072, rl: "OrbFrame._1", bake: "orb_frame_hover", w: 57, h: 34, ox: 0, oy: 0, mw: 57, mh: 34, avg: "#463e34" },
  orbEmpty: { id: 1059, rl: "OrbFiller._0", bake: "orb_fill_empty", w: 26, h: 26, ox: 0, oy: 0, mw: 26, mh: 26, avg: "#0f0e0f" },
  orbFillRun: { id: 1064, rl: "OrbFiller._5", bake: "orb_fill_run", w: 26, h: 26, ox: 0, oy: 0, mw: 26, mh: 26, avg: "#7a7a75" },
  orbFillUsdc: { id: 1066, rl: "OrbFiller._7", bake: "orb_fill_prayer_active", w: 26, h: 26, ox: 0, oy: 0, mw: 26, mh: 26, avg: "#555385" },
  orbIconWalk: { id: 1069, rl: "OrbIcon._2", bake: "orb_icon_walk", w: 15, h: 18, ox: 6, oy: 4, mw: 26, mh: 26, avg: "#5c4026" },
  orbIconRun: { id: 1070, rl: "OrbIcon._3", bake: "orb_icon_run", w: 15, h: 18, ox: 6, oy: 4, mw: 26, mh: 26, avg: "#948138" },
  optionBox: { id: 761, rl: "OptionsBoxes._0", w: 40, h: 40, ox: 0, oy: 0, mw: 40, mh: 40, avg: "#4f4d47" },
  optionBoxActive: { id: 762, rl: "OptionsBoxes._1", w: 40, h: 40, ox: 0, oy: 0, mw: 40, mh: 40, avg: "#7c1d1b" },
  optionIconMusic: { id: 660, rl: "OptionsIcons._1", w: 27, h: 31, ox: 3, oy: 0, mw: 32, mh: 32, avg: "#423f3b" },
  optionIconMusicOff: { id: 666, rl: "OptionsIcons._7", w: 30, h: 31, ox: 1, oy: 0, mw: 32, mh: 32, avg: "#4f1a19" },
  optionIconSound: { id: 661, rl: "OptionsIcons._2", w: 31, h: 30, ox: 1, oy: 0, mw: 32, mh: 32, avg: "#38332d" },
  optionIconSoundOff: { id: 667, rl: "OptionsIcons._8", w: 31, h: 30, ox: 1, oy: 0, mw: 32, mh: 32, avg: "#4b1c19" },
  optionIconChatEffects: { id: 662, rl: "OptionsIcons._3", w: 32, h: 26, ox: 0, oy: 3, mw: 32, mh: 32, avg: "#a6a39d" },
  optionIconWalk: { id: 669, rl: "OptionsIcons._10", w: 20, h: 32, ox: 8, oy: 0, mw: 32, mh: 32, avg: "#3d3835" },
  sliderLeft: { id: 679, rl: "OptionsSlider._0", bake: "slider_1_of_4", w: 32, h: 14, ox: 0, oy: 1, mw: 32, mh: 16, avg: "#433c32" },
  sliderMiddleA: { id: 680, rl: "OptionsSlider._1", bake: "slider_2_of_4", w: 32, h: 14, ox: 0, oy: 1, mw: 32, mh: 16, avg: "#443c32" },
  sliderMiddleB: { id: 681, rl: "OptionsSlider._2", bake: "slider_3_of_4", w: 32, h: 14, ox: 0, oy: 1, mw: 32, mh: 16, avg: "#494135" },
  sliderRight: { id: 682, rl: "OptionsSlider._3", bake: "slider_4_of_4", w: 32, h: 14, ox: 0, oy: 1, mw: 32, mh: 16, avg: "#4a4337" },
  sliderLeftKnob: { id: 683, rl: "OptionsSlider._4", bake: "slider_thumb_1_of_4", w: 32, h: 16, ox: 0, oy: 0, mw: 32, mh: 16, avg: "#3e4148" },
  sliderMiddleAKnob: { id: 684, rl: "OptionsSlider._5", bake: "slider_thumb_2_of_4", w: 32, h: 16, ox: 0, oy: 0, mw: 32, mh: 16, avg: "#3d3e43" },
  sliderMiddleBKnob: { id: 685, rl: "OptionsSlider._6", bake: "slider_thumb_3_of_4", w: 32, h: 16, ox: 0, oy: 0, mw: 32, mh: 16, avg: "#404145" },
  sliderRightKnob: { id: 686, rl: "OptionsSlider._7", bake: "slider_thumb_4_of_4", w: 32, h: 16, ox: 0, oy: 0, mw: 32, mh: 16, avg: "#3f4047" },
  checkbox: { id: 1215, rl: "Checkbox._0", bake: "checkbox_empty", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#3d3830" },
  checkboxChecked: { id: 1217, rl: "Checkbox._2", bake: "checkbox_checked", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#3b3e31" },
  checkboxHover: { id: 1218, rl: "Checkbox._3", bake: "checkbox_hover", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#565248" },
  checkboxCheckedHover: { id: 1220, rl: "Checkbox._5", bake: "checkbox_checked_hover", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#535747" },
  emoteYes: { id: 700, rl: "Emotes._0", bake: "emote_yes", w: 25, h: 47, ox: 12, oy: 1, mw: 48, mh: 48, avg: "#62594c" },
  emoteNo: { id: 701, rl: "Emotes._1", bake: "emote_no", w: 25, h: 47, ox: 12, oy: 1, mw: 48, mh: 48, avg: "#615749" },
  emoteThink: { id: 702, rl: "Emotes._2", bake: "emote_think", w: 28, h: 47, ox: 11, oy: 1, mw: 48, mh: 48, avg: "#413a20" },
  emoteBow: { id: 703, rl: "Emotes._3", bake: "emote_bow", w: 29, h: 39, ox: 12, oy: 8, mw: 48, mh: 48, avg: "#5b5449" },
  emoteAngry: { id: 704, rl: "Emotes._4", bake: "emote_angry", w: 29, h: 47, ox: 7, oy: 1, mw: 48, mh: 48, avg: "#554e44" },
  emoteCry: { id: 705, rl: "Emotes._5", bake: "emote_cry", w: 31, h: 46, ox: 9, oy: 2, mw: 48, mh: 48, avg: "#3c2a25" },
  emoteLaugh: { id: 706, rl: "Emotes._6", bake: "emote_laugh", w: 25, h: 47, ox: 12, oy: 1, mw: 48, mh: 48, avg: "#4a4237" },
  emoteCheer: { id: 707, rl: "Emotes._7", bake: "emote_cheer", w: 35, h: 47, ox: 7, oy: 1, mw: 48, mh: 48, avg: "#3d381e" },
  emoteWave: { id: 708, rl: "Emotes._8", bake: "emote_wave", w: 32, h: 47, ox: 6, oy: 1, mw: 48, mh: 48, avg: "#3c351e" },
  emoteBeckon: { id: 709, rl: "Emotes._9", bake: "emote_beckon", w: 28, h: 47, ox: 10, oy: 1, mw: 48, mh: 48, avg: "#413b32" },
  emoteDance: { id: 710, rl: "Emotes._10", bake: "emote_dance", w: 31, h: 47, ox: 7, oy: 1, mw: 48, mh: 48, avg: "#5c3c13" },
  emoteClap: { id: 711, rl: "Emotes._11", bake: "emote_clap", w: 28, h: 47, ox: 11, oy: 1, mw: 48, mh: 48, avg: "#5e5548" },
  emoteJump: { id: 716, rl: "Emotes._16", bake: "emote_jump", w: 34, h: 43, ox: 9, oy: 0, mw: 48, mh: 48, avg: "#484035" },
  emoteShrug: { id: 720, rl: "Emotes._20", bake: "emote_shrug", w: 31, h: 47, ox: 9, oy: 1, mw: 48, mh: 48, avg: "#3d381e" },
  geBuy: { id: 1108, rl: "GeIcons._2", bake: "ge_offer_buy", w: 26, h: 35, ox: 4, oy: 0, mw: 35, mh: 35, avg: "#5e4014" },
  geBuyHover: { id: 1109, rl: "GeIcons._3", bake: "ge_offer_buy_hover", w: 26, h: 35, ox: 4, oy: 0, mw: 35, mh: 35, avg: "#876d4f" },
  geSell: { id: 1106, rl: "GeIcons._0", bake: "ge_offer_sell", w: 26, h: 35, ox: 4, oy: 0, mw: 35, mh: 35, avg: "#5f3713" },
  geSellHover: { id: 1107, rl: "GeIcons._1", bake: "ge_offer_sell_hover", w: 26, h: 35, ox: 4, oy: 0, mw: 35, mh: 35, avg: "#86694e" },
  geItemBox: { id: 1120, rl: "GeItembackdrop._0", bake: "ge_item_backdrop", w: 40, h: 36, ox: 0, oy: 0, mw: 40, mh: 36, avg: "#43392c" },
  geItemBoxSelected: { id: 1121, rl: "GeItembackdrop._1", bake: "ge_item_backdrop_glow", w: 40, h: 36, ox: 0, oy: 0, mw: 40, mh: 36, avg: "#55471c" },
  geTextLeft: { id: 1123, rl: "GeTextbackdrop._0", bake: "ge_text_left", w: 4, h: 20, ox: 0, oy: 0, mw: 4, mh: 20, avg: "#30271b" },
  geTextMiddle: { id: 1124, rl: "GeTextbackdrop._1", bake: "ge_text_middle", w: 4, h: 20, ox: 0, oy: 0, mw: 4, mh: 20, avg: "#352c20" },
  geTextRight: { id: 1125, rl: "GeTextbackdrop._2", bake: "ge_text_right", w: 4, h: 20, ox: 0, oy: 0, mw: 4, mh: 20, avg: "#362d21" },
  geCancel: { id: 1126, rl: "GeCancel._0", bake: "ge_cancel", w: 20, h: 20, ox: 0, oy: 0, mw: 20, mh: 20, avg: "#5b0f0b" },
  geCancelHover: { id: 1127, rl: "GeCancel._1", bake: "ge_cancel_hover", w: 20, h: 20, ox: 0, oy: 0, mw: 20, mh: 20, avg: "#340905" },
  geBack: { id: 1122, rl: "GE_BACKBUTTON", bake: "ge_back", w: 30, h: 23, ox: 0, oy: 0, mw: 30, mh: 23, avg: "#807770" },
  orbFillRunActive: { id: 1065, rl: "OrbFiller._6", bake: "orb_fill_run_active", w: 26, h: 26, ox: 0, oy: 0, mw: 26, mh: 26, avg: "#aa8a00" },
  closeButtonParchment: { id: 537, rl: "CloseButtons._2", bake: "close_button_parchment", w: 23, h: 23, ox: 1, oy: 0, mw: 26, mh: 23, avg: "#82704c" },
  closeButtonParchmentHover: { id: 538, rl: "CloseButtons._3", bake: "close_button_parchment_hover", w: 23, h: 23, ox: 1, oy: 0, mw: 26, mh: 23, avg: "#8d7b58" },
  parchmentScroll: { id: 3395, rl: "(bake) parchment_scroll", bake: "parchment_scroll", w: 306, h: 289, ox: 104, oy: 19, mw: 512, mh: 334, avg: "#745d36" },
  slotTile: { id: 170, rl: "Miscgraphics._0", bake: "slot_tile", w: 36, h: 36, ox: 0, oy: 0, mw: 36, mh: 36, avg: "#4f4d47" },
  tick: { id: 1210, rl: "TICK", bake: "tick", w: 15, h: 12, ox: 1, oy: 2, mw: 17, mh: 17, avg: "#4f6d47" },
  checkboxCrossed: { id: 1216, rl: "Checkbox._1", bake: "checkbox_crossed", w: 16, h: 16, ox: 0, oy: 0, mw: 16, mh: 16, avg: "#48312c" },
  interfaceBackgroundDark: { id: 897, rl: "TRADEBACKING_DARK", bake: "interface_background_dark", w: 88, h: 60, ox: 0, oy: 0, mw: 88, mh: 60, avg: "#3e3429" },
  interfaceBackgroundLight: { id: 1040, rl: "TRADEBACKING_LIGHT", bake: "interface_background_light", w: 88, h: 60, ox: 0, oy: 0, mw: 88, mh: 60, avg: "#534a3f" },
  interfaceBackgroundBeige: { id: 1545, rl: "TRADEBACKING_BEIGE", bake: "interface_background_beige", w: 88, h: 60, ox: 0, oy: 0, mw: 88, mh: 60, avg: "#b29d7b" },
  geButton: { id: 1110, rl: "GeIcons._4", bake: "ge_button", w: 35, h: 25, ox: 0, oy: 5, mw: 35, mh: 35, avg: "#554b3e" },
  geButtonHover: { id: 1111, rl: "GeIcons._5", bake: "ge_button_hover", w: 35, h: 25, ox: 0, oy: 5, mw: 35, mh: 35, avg: "#3f3930" },
  geGuidePrice: { id: 1112, rl: "GeSmallicons._0", bake: "ge_guide_price", w: 20, h: 18, ox: 0, oy: 0, mw: 20, mh: 18, avg: "#aa7949" },
  geSearch: { id: 1113, rl: "GeSmallicons._1", bake: "ge_search", w: 14, h: 14, ox: 2, oy: 2, mw: 20, mh: 18, avg: "#625542" },
  geDecrementFast: { id: 1114, rl: "GeSmallicons._2", bake: "ge_decrement_fast", w: 14, h: 7, ox: 2, oy: 6, mw: 20, mh: 18, avg: "#b16900" },
  geIncrementFast: { id: 1115, rl: "GeSmallicons._3", bake: "ge_increment_fast", w: 14, h: 7, ox: 3, oy: 5, mw: 20, mh: 18, avg: "#b16900" },
  geDecrement: { id: 1116, rl: "GeSmallicons._4", bake: "ge_decrement", w: 13, h: 13, ox: 4, oy: 2, mw: 20, mh: 18, avg: "#62594c" },
  geIncrement: { id: 1117, rl: "GeSmallicons._5", bake: "ge_increment", w: 13, h: 13, ox: 4, oy: 2, mw: 20, mh: 18, avg: "#5f5649" },
  geCollectBuy: { id: 1118, rl: "GeSmallicons._6", bake: "ge_collect_buy", w: 11, h: 14, ox: 5, oy: 2, mw: 20, mh: 18, avg: "#6c5b13" },
  geCollectSell: { id: 1119, rl: "GeSmallicons._7", bake: "ge_collect_sell", w: 11, h: 14, ox: 5, oy: 2, mw: 20, mh: 18, avg: "#744d13" },
  bankTab: { id: 1077, rl: "Banktabs._0", bake: "bank_tab", w: 41, h: 40, ox: 0, oy: 0, mw: 41, mh: 40, avg: "#41392e" },
  bankTabHover: { id: 1078, rl: "Banktabs._1", bake: "bank_tab_hover", w: 41, h: 40, ox: 0, oy: 0, mw: 41, mh: 40, avg: "#483f34" },
  bankTabSelected: { id: 1079, rl: "Banktabs._2", bake: "bank_tab_selected", w: 41, h: 40, ox: 0, oy: 0, mw: 41, mh: 40, avg: "#473f33" },
  bankTabEmpty: { id: 1080, rl: "Banktabs._3", bake: "bank_tab_empty", w: 41, h: 40, ox: 0, oy: 0, mw: 41, mh: 40, avg: "#3b342a" },
  bankTabIconAll: { id: 1081, rl: "BanktabIcons._0", bake: "bank_tab_icon_all", w: 24, h: 15, ox: 7, oy: 9, mw: 36, mh: 32, avg: "#615346" },
  bankTabIconAdd: { id: 1082, rl: "BanktabIcons._1", bake: "bank_tab_icon_add", w: 17, h: 17, ox: 10, oy: 9, mw: 36, mh: 32, avg: "#5f4f45" },
  bankDepositInventory: { id: 1041, rl: "Bankbuttons._0", bake: "bank_deposit_inventory", w: 28, h: 21, ox: 1, oy: 1, mw: 29, mh: 22, avg: "#413d17" },
  bankDepositEquipment: { id: 1042, rl: "Bankbuttons._1", bake: "bank_deposit_equipment", w: 28, h: 21, ox: 1, oy: 1, mw: 29, mh: 22, avg: "#2e482a" },
  bankSearch: { id: 1043, rl: "Bankbuttons._2", bake: "bank_search", w: 20, h: 20, ox: 5, oy: 1, mw: 29, mh: 22, avg: "#54504b" },
  bankModeInsert: { id: 2820, rl: "Bankbuttons._11", bake: "bank_mode_insert", w: 20, h: 20, ox: 5, oy: 1, mw: 29, mh: 22, avg: "#466641" },
  bankModeSwap: { id: 2821, rl: "Bankbuttons._12", bake: "bank_mode_swap", w: 20, h: 21, ox: 5, oy: 0, mw: 29, mh: 22, avg: "#43683f" },
  bankWithdrawNote: { id: 2822, rl: "Bankbuttons._13", bake: "bank_withdraw_note", w: 19, h: 19, ox: 5, oy: 2, mw: 29, mh: 22, avg: "#7d7255" },
  bankPlaceholders: { id: 1342, rl: "Bankbuttons._7", bake: "bank_placeholders", w: 17, h: 21, ox: 7, oy: 1, mw: 29, mh: 22, avg: "#875e2b" },
  bankArrowGreen: { id: 2496, rl: "BANKBUTTON_ARROW_GREEN", bake: "bank_arrow_green", w: 12, h: 10, ox: 0, oy: 0, mw: 12, mh: 10, avg: "#1c931f" },
  frameMiniLeft: { id: 1037, rl: "MINI_LEFT", bake: "frame_mini_left", w: 29, h: 156, ox: 0, oy: 0, mw: 29, mh: 156, avg: "#423d2d" },
  frameMiniRight: { id: 1038, rl: "MINI_RIGHT", bake: "frame_mini_right", w: 48, h: 156, ox: 0, oy: 0, mw: 48, mh: 156, avg: "#27241c" },
  frameMiniBottom: { id: 1611, rl: "MINI_BOTTOM", bake: "frame_mini_bottom", w: 249, h: 8, ox: 0, oy: 0, mw: 249, mh: 8, avg: "#27241d" },
  frameMiniTopRight: { id: 1441, rl: "MINI_TOPRIGHT", bake: "frame_mini_top_right", w: 48, h: 4, ox: 0, oy: 0, mw: 48, mh: 4, avg: "#4f482b" },
  info: { id: 1236, rl: "INFO", bake: "info", w: 9, h: 22, ox: 8, oy: 2, mw: 25, mh: 25, avg: "#646465" },
  exclamationMark: { id: 937, rl: "EXCLAMATION_MARK", bake: "exclamation_mark", w: 10, h: 32, ox: 0, oy: 0, mw: 10, mh: 32, avg: "#850a07" },
  itemCoins1: { id: 995, frame: 1, rl: "ItemID.COINS x1", bake: "item_coins_1", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#664d0d" },
  itemCoins2: { id: 995, frame: 2, rl: "ItemID.COINS x2", bake: "item_coins_2", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#694f0d" },
  itemCoins3: { id: 995, frame: 3, rl: "ItemID.COINS x3", bake: "item_coins_3", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#6d530e" },
  itemCoins4: { id: 995, frame: 4, rl: "ItemID.COINS x4", bake: "item_coins_4", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#73570d" },
  itemCoins5: { id: 995, frame: 5, rl: "ItemID.COINS x5", bake: "item_coins_5", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#74580d" },
  itemCoins25: { id: 995, frame: 25, rl: "ItemID.COINS x25", bake: "item_coins_25", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#7c5e0d" },
  itemCoins100: { id: 995, frame: 100, rl: "ItemID.COINS x100", bake: "item_coins_100", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#82620c" },
  itemCoins250: { id: 995, frame: 250, rl: "ItemID.COINS x250", bake: "item_coins_250", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#84640a" },
  itemCoins1000: { id: 995, frame: 1000, rl: "ItemID.COINS x1000", bake: "item_coins_1000", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#6b5109" },
  itemCoins10000: { id: 995, frame: 10000, rl: "ItemID.COINS x10000", bake: "item_coins_10000", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#735709" },
  itemBankNote: { id: 995, rl: "ItemID.COINS noted", bake: "item_bank_note", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#7a6a42" },
  itemNoteBlank: { id: 799, frame: 1, rl: "ItemID.BANK_NOTE", bake: "item_note_blank", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#81714e" },
  itemClueScroll: { id: 2677, frame: 1, rl: "ItemID.CLUE_SCROLL", bake: "item_clue_scroll", w: 36, h: 32, ox: 0, oy: 0, mw: 36, mh: 32, avg: "#5b4a2c" },
} as const satisfies Record<string, SpriteDef>;

export type SpriteName = keyof typeof SPRITES;

/** One sprite the kit needs, for the bake to export. */
export interface SpriteRef {
  name: SpriteName;
  id: number;
  frame: number;
  rl: string;
  bake?: string;
}

/** Every sprite the kit references (archive or item id, frame, names). */
export const UI_SPRITE_REFS: readonly SpriteRef[] = (Object.entries(SPRITES) as [SpriteName, SpriteDef][]).map(([name, d]) => ({
  name,
  id: d.id,
  frame: d.frame ?? 0,
  rl: d.rl,
  ...(d.bake ? { bake: d.bake } : {}),
}));

/** Sprite archive ids (frame 0, excluding item icons) the kit references. */
export const UI_SPRITE_IDS: readonly number[] = [
  ...new Set(UI_SPRITE_REFS.filter((r) => !r.rl.startsWith("ItemID")).map((r) => r.id)),
].sort((a, b) => a - b);

/** Conventional file name for a sprite frame inside the sprites directory. */
export function spriteFileName(id: number, frame = 0): string {
  return `${id}_${frame}.png`;
}

/** The coins item icon for a stack, using the client's pile thresholds. */
export function coinsSpriteFor(quantity: number): SpriteName {
  const n = Math.max(1, Math.floor(Number.isFinite(quantity) ? quantity : 1));
  if (n >= 10_000) return "itemCoins10000";
  if (n >= 1_000) return "itemCoins1000";
  if (n >= 250) return "itemCoins250";
  if (n >= 100) return "itemCoins100";
  if (n >= 25) return "itemCoins25";
  if (n >= 5) return "itemCoins5";
  if (n === 4) return "itemCoins4";
  if (n === 3) return "itemCoins3";
  if (n === 2) return "itemCoins2";
  return "itemCoins1";
}
