#include "display.h"

#include <SPI.h>
#include <lvgl.h>

#include <cstdio>
#include <cstring>

#include "config.h"
#include "node_registry.h"

LV_FONT_DECLARE(my_font_16);


// ── SPI pin config (from config.h) ──────────────────────────────────────
#define PIN_BL    TFT_BACKLIGHT_PIN   // 7
#define PIN_DC    TFT_DC_PIN          // 8
#define PIN_RST   TFT_RST_PIN         // 9
#define PIN_CS    TFT_CS_PIN          // 10
#define PIN_MOSI  TFT_MOSI_PIN        // 11
#define PIN_SCLK  TFT_SCLK_PIN        // 12

// ── Display dimensions ──────────────────────────────────────────────────
constexpr uint16_t DISP_W = DISPLAY_WIDTH;   // 240
constexpr uint16_t DISP_H = DISPLAY_HEIGHT;  // 320

namespace {

// ── Layout constants ──────────────────────────────────────────────────
constexpr lv_coord_t kTabHeight = 36;
constexpr size_t kMaxNodeRows = 8;  // must match MAX_DISPLAY_NODES

// Column x positions for the node table (240 px wide)
constexpr lv_coord_t kColID    = 8;
constexpr lv_coord_t kColName  = 44;
constexpr lv_coord_t kColTemp  = 100;
constexpr lv_coord_t kColHum   = 146;
constexpr lv_coord_t kColBat   = 180;
// Row layout
constexpr lv_coord_t kHeaderY    = 6;
constexpr lv_coord_t kSepY       = 24;
constexpr lv_coord_t kRowStartY  = 32;
constexpr lv_coord_t kRowStep    = 22;

// Gateway tab row Y positions (evenly spaced, 34px apart)
constexpr lv_coord_t kGW_Y[] = {8, 44, 80, 116, 152, 188};
constexpr lv_coord_t kGW_LABEL_X = 14;    // label col ("名称:")
constexpr lv_coord_t kGW_VALUE_X = 100;   // value col

const lv_color_t kBgColor = lv_color_make(0x12, 0x12, 0x20);  // dark
const lv_color_t kValueColor = lv_color_make(0xCC, 0xDD, 0xFF); // soft white-blue

// ── Display driver objects ────────────────────────────────────────────
lv_disp_draw_buf_t disp_buf;
lv_color_t buf[DISP_W * 40];
lv_disp_drv_t disp_drv;

// ── Low-level SPI helpers ─────────────────────────────────────────────
static void spi_cmd(uint8_t cmd) {
    digitalWrite(PIN_DC, LOW);
    digitalWrite(PIN_CS, LOW);
    SPI.transfer(cmd);
    digitalWrite(PIN_CS, HIGH);
}

static void spi_data(uint8_t d) {
    digitalWrite(PIN_DC, HIGH);
    digitalWrite(PIN_CS, LOW);
    SPI.transfer(d);
    digitalWrite(PIN_CS, HIGH);
}

// ── UI widget pointers ───────────────────────────────────────────────
lv_obj_t *tabview = nullptr;

// Gateway page
lv_obj_t *gw_name_label  = nullptr;   // value for "名称"
lv_obj_t *gw_wifi_label  = nullptr;
lv_obj_t *gw_mqtt_label  = nullptr;
lv_obj_t *gw_ip_label    = nullptr;
lv_obj_t *gw_rssi_label  = nullptr;
lv_obj_t *gw_nodes_label = nullptr;

// Nodes page
lv_obj_t *no_nodes_label = nullptr;

struct RowWidgets {
    lv_obj_t *id;
    lv_obj_t *name;
    lv_obj_t *temp;
    lv_obj_t *hum;
    lv_obj_t *bat;
};
RowWidgets rows[kMaxNodeRows]    = {};
uint16_t    row_ids[kMaxNodeRows] = {};  // 0 = empty slot

// ── State ─────────────────────────────────────────────────────────────
bool          display_ready   = false;
bool          wifi_ok         = false;
bool          mqtt_ok         = false;
int           current_rssi    = 0;
char          current_ip[24]  = "0.0.0.0";
uint8_t       current_page    = 0;

// Button debounce (hardware not yet fitted — placeholder)
bool          btn_last        = HIGH;
uint32_t      btn_change_ms   = 0;

// Auto-tab-switch timer (10 s per page while no hardware button)
constexpr uint32_t kTabSwitchIntervalMs = 10000;
uint32_t      last_tab_switch_ms = 0;

// ── Styles ────────────────────────────────────────────────────────────
lv_style_t style_label;         // label name: SimSun 16, dim white
lv_style_t style_value;         // data value: Montserrat 14, soft white-blue
lv_style_t style_title;         // column header / label name: SimSun 16, grey-blue
lv_style_t style_status_ok;    // green
lv_style_t style_status_warn;  // yellow

// ══════════════════════════════════════════════════════════════════════
//  LVGL display driver: raw SPI flush callback
// ══════════════════════════════════════════════════════════════════════
static void disp_flush(lv_disp_drv_t *disp, const lv_area_t *area,
                       lv_color_t *color_p) {
    const uint32_t w = area->x2 - area->x1 + 1;
    const uint32_t h = area->y2 - area->y1 + 1;
    auto *pixels = reinterpret_cast<uint16_t *>(color_p);

    SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));

    // Set address window
    spi_cmd(0x2A);
    spi_data(area->x1 >> 8); spi_data(area->x1 & 0xFF);
    spi_data(area->x2 >> 8); spi_data(area->x2 & 0xFF);
    spi_cmd(0x2B);
    spi_data(area->y1 >> 8); spi_data(area->y1 & 0xFF);
    spi_data(area->y2 >> 8); spi_data(area->y2 & 0xFF);
    spi_cmd(0x2C);  // RAMWR

    // Send pixel data: high byte first
    digitalWrite(PIN_DC, HIGH);
    digitalWrite(PIN_CS, LOW);
    for (uint32_t i = 0; i < w * h; i++) {
        SPI.transfer(pixels[i] >> 8);   // high byte
        SPI.transfer(pixels[i] & 0xFF); // low byte
    }
    digitalWrite(PIN_CS, HIGH);

    SPI.endTransaction();

    lv_disp_flush_ready(disp);
}

// ══════════════════════════════════════════════════════════════════════
//  Raw SPI: fill entire screen with a solid RGB565 color
// ══════════════════════════════════════════════════════════════════════
static void raw_fill(uint16_t color565) {
    SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
    spi_cmd(0x2A);
    spi_data(0x00); spi_data(0x00);
    spi_data(0x00); spi_data(DISP_W - 1);
    spi_cmd(0x2B);
    spi_data(0x00); spi_data(0x00);
    spi_data(0x01); spi_data((DISP_H - 1) & 0xFF);  // 0x013F = 319
    spi_cmd(0x2C);  // RAMWR

    digitalWrite(PIN_DC, HIGH);
    digitalWrite(PIN_CS, LOW);
    for (uint32_t i = 0; i < DISP_W * DISP_H; i++) {
        SPI.transfer(color565 >> 8);
        SPI.transfer(color565 & 0xFF);
    }
    digitalWrite(PIN_CS, HIGH);
    SPI.endTransaction();
}

// ══════════════════════════════════════════════════════════════════════
//  Raw SPI: fill a screen sub-region with a solid RGB565 color
// ══════════════════════════════════════════════════════════════════════
static void raw_fill_region(uint16_t color565, uint16_t x1, uint16_t y1,
                            uint16_t x2, uint16_t y2) {
    const uint32_t w = x2 - x1 + 1;
    const uint32_t h = y2 - y1 + 1;

    SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
    spi_cmd(0x2A);
    spi_data(x1 >> 8); spi_data(x1 & 0xFF);
    spi_data(x2 >> 8); spi_data(x2 & 0xFF);
    spi_cmd(0x2B);
    spi_data(y1 >> 8); spi_data(y1 & 0xFF);
    spi_data(y2 >> 8); spi_data(y2 & 0xFF);
    spi_cmd(0x2C);  // RAMWR

    digitalWrite(PIN_DC, HIGH);
    digitalWrite(PIN_CS, LOW);
    for (uint32_t i = 0; i < w * h; i++) {
        SPI.transfer(color565 >> 8);
        SPI.transfer(color565 & 0xFF);
    }
    digitalWrite(PIN_CS, HIGH);
    SPI.endTransaction();
}

// ══════════════════════════════════════════════════════════════════════
//  Boot sweep animation
//  Plays on every power-on / reboot before the UI is built, so a restart
//  (e.g. after the serial "reboot" command) is visibly confirmed on screen.
//  Only newly-covered rows are painted each frame (curtain sweep).
// ══════════════════════════════════════════════════════════════════════
static void boot_sweep_animation() {
    const uint16_t kStep = 8;         // rows painted per frame
    const uint32_t kFrameMs = 5;      // pause per frame

    // Sweep down: cyan front edge fills from top to bottom
    for (uint16_t y = 0; y < DISP_H; y += kStep) {
        uint16_t y2 = y + kStep - 1;
        if (y2 >= DISP_H) y2 = DISP_H - 1;
        raw_fill_region(0x07FF, 0, y, DISP_W - 1, y2);  // cyan
        delay(kFrameMs);
    }
    // Sweep up: magenta front edge fills from bottom to top
    for (uint16_t y = DISP_H; y > 0; ) {
        const uint16_t y1 = y - kStep;
        raw_fill_region(0xF81F, 0, y1, DISP_W - 1, y - 1);  // magenta
        y = y1;
        delay(kFrameMs);
    }
    // Blink white to confirm, then back to black
    raw_fill(0xFFFF);
    delay(80);
    raw_fill(0x0000);
}

// ══════════════════════════════════════════════════════════════════════
//  Create a label
// ══════════════════════════════════════════════════════════════════════
static lv_obj_t *make_label(lv_obj_t *parent, const char *text,
                            lv_style_t *style, lv_coord_t x, lv_coord_t y) {
    lv_obj_t *lbl = lv_label_create(parent);
    lv_label_set_text(lbl, text);
    if (style) lv_obj_add_style(lbl, style, 0);
    lv_obj_set_pos(lbl, x, y);
    return lbl;
}

// ══════════════════════════════════════════════════════════════════════
//  Gateway tab
// ══════════════════════════════════════════════════════════════════════
static void build_gateway_tab(lv_obj_t *parent) {
    // Row 0: 名称
    make_label(parent, "名称", &style_title, kGW_LABEL_X, kGW_Y[0]);
    gw_name_label = make_label(parent, gateway_config.gateway_name,
                               &style_label, kGW_VALUE_X, kGW_Y[0]);

    // Row 1: Wi-Fi
    make_label(parent, "Wi-Fi", &style_title, kGW_LABEL_X, kGW_Y[1]);
    gw_wifi_label =
        make_label(parent, "Offline", &style_status_warn, kGW_VALUE_X, kGW_Y[1]);

    // Row 2: MQTT
    make_label(parent, "MQTT", &style_title, kGW_LABEL_X, kGW_Y[2]);
    gw_mqtt_label =
        make_label(parent, "Offline", &style_status_warn, kGW_VALUE_X, kGW_Y[2]);

    // Row 3: IP
    make_label(parent, "IP", &style_title, kGW_LABEL_X, kGW_Y[3]);
    gw_ip_label = make_label(parent, "0.0.0.0", &style_value, kGW_VALUE_X, kGW_Y[3]);

    // Row 4: 信号
    make_label(parent, "信号", &style_title, kGW_LABEL_X, kGW_Y[4]);
    gw_rssi_label = make_label(parent, "-- dBm", &style_value, kGW_VALUE_X, kGW_Y[4]);

    // Row 5: 节点
    make_label(parent, "节点", &style_title, kGW_LABEL_X, kGW_Y[5]);
    gw_nodes_label = make_label(parent, "0", &style_value, kGW_VALUE_X, kGW_Y[5]);
}

// ══════════════════════════════════════════════════════════════════════
//  Nodes tab
// ══════════════════════════════════════════════════════════════════════
static void build_nodes_tab(lv_obj_t *parent) {
    // Column headers
    make_label(parent, "ID",   &style_title, kColID,   kHeaderY);
    make_label(parent, "名称", &style_title, kColName, kHeaderY);
    make_label(parent, "温度", &style_title, kColTemp, kHeaderY);
    make_label(parent, "湿度", &style_title, kColHum,  kHeaderY);
    make_label(parent, "电池", &style_title, kColBat,  kHeaderY);

    // Separator line below header
    static lv_point_t line_pts[] = {{kColID, kSepY}, {kColBat + 52, kSepY}};
    lv_obj_t *sep = lv_line_create(parent);
    lv_line_set_points(sep, line_pts, 2);
    lv_obj_set_style_line_color(sep, lv_palette_main(LV_PALETTE_GREY), 0);
    lv_obj_set_style_line_width(sep, 1, 0);

    // "No nodes" placeholder
    no_nodes_label =
        make_label(parent, "暂无节点数据", &style_title, 60, 140);

    // Pre-create row labels (initially hidden by empty text)
    for (size_t i = 0; i < kMaxNodeRows; ++i) {
        rows[i].id   = make_label(parent, "", &style_value,
                                  kColID,   kRowStartY + i * kRowStep);
        rows[i].name = make_label(parent, "", &style_label,
                                  kColName, kRowStartY + i * kRowStep);
        rows[i].temp = make_label(parent, "", &style_value,
                                  kColTemp, kRowStartY + i * kRowStep);
        rows[i].hum  = make_label(parent, "", &style_value,
                                  kColHum,  kRowStartY + i * kRowStep);
        rows[i].bat  = make_label(parent, "", &style_value,
                                  kColBat,  kRowStartY + i * kRowStep);
    }
}

// ══════════════════════════════════════════════════════════════════════
//  Build complete LVGL UI
// ══════════════════════════════════════════════════════════════════════
static void build_ui() {
    // ── Screen background ──────────────────────────────────────────
    lv_obj_set_style_bg_color(lv_scr_act(), kBgColor, 0);
    lv_obj_set_style_bg_opa(lv_scr_act(), LV_OPA_COVER, 0);

    tabview = lv_tabview_create(lv_scr_act(), LV_DIR_TOP, kTabHeight);

    // Apply CJK font to tab buttons (LV_PART_ITEMS, not LV_PART_MAIN)
    lv_obj_t *tab_btns = lv_tabview_get_tab_btns(tabview);
    lv_obj_add_style(tab_btns, &style_label, LV_PART_ITEMS);
    lv_obj_add_style(tab_btns, &style_label, LV_PART_ITEMS | LV_STATE_CHECKED);
    // Dark background for the button bar
    lv_obj_set_style_bg_color(tab_btns, lv_color_make(0x1A, 0x1A, 0x30), 0);

    // Set tab button background to match our theme
    lv_obj_set_style_bg_color(tabview, kBgColor, 0);
    lv_obj_set_style_bg_color(lv_tabview_get_content(tabview), kBgColor, 0);

    lv_obj_t *t1 = lv_tabview_add_tab(tabview, "网关");
    lv_obj_t *t2 = lv_tabview_add_tab(tabview, "节点");

    // Set tab page backgrounds
    lv_obj_set_style_bg_color(t1, kBgColor, 0);
    lv_obj_set_style_bg_color(t2, kBgColor, 0);

    build_gateway_tab(t1);
    build_nodes_tab(t2);
}

// ══════════════════════════════════════════════════════════════════════
//  Button polling (debounced, tab switch)
// ══════════════════════════════════════════════════════════════════════
static void poll_button() {
    const bool level = digitalRead(TAB_BUTTON_PIN);
    if (level != btn_last) {
        btn_change_ms = millis();
        btn_last = level;
    }
    if ((millis() - btn_change_ms) < 25) return;

    static bool latched = false;
    if (!level && !latched) {
        current_page = (current_page == 0) ? 1 : 0;
        lv_tabview_set_act(tabview, current_page, LV_ANIM_ON);
        latched = true;
    } else if (level) {
        latched = false;
    }
}

// ══════════════════════════════════════════════════════════════════════
//  Count active nodes
// ══════════════════════════════════════════════════════════════════════
static int active_node_count() {
    int n = 0;
    for (auto id : row_ids) {
        if (id != 0) ++n;
    }
    return n;
}

}  // anonymous namespace

// ════════════════════════════════════════════════════════════════════════
//  Public API
// ════════════════════════════════════════════════════════════════════════

bool display_init() {
    // ── Button pin ─────────────────────────────────────────────────
    pinMode(TAB_BUTTON_PIN, INPUT_PULLUP);

    // ── HW init: raw SPI (no TFT_eSPI) ────────────────────────────
    pinMode(PIN_BL, OUTPUT);

    pinMode(PIN_DC, OUTPUT);
    pinMode(PIN_RST, OUTPUT);
    pinMode(PIN_CS, OUTPUT);
    digitalWrite(PIN_DC, HIGH);
    digitalWrite(PIN_CS, HIGH);

    // Hardware reset
    digitalWrite(PIN_RST, LOW);
    delay(50);
    digitalWrite(PIN_RST, HIGH);
    delay(120);

    // SPI bus
    SPI.begin(PIN_SCLK, -1, PIN_MOSI, -1);

    // ── ST7789 init ───────────────────────────────────────────────
    SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
    spi_cmd(0x01); delay(150);         // SWRESET
    spi_cmd(0x11); delay(120);         // SLPOUT

    spi_cmd(0x36); spi_data(0x00);     // MADCTL = RGB
    spi_cmd(0x3A); spi_data(0x55);     // COLMOD = 16-bit

    spi_cmd(0xB6);                     // RAMCTRL
    spi_data(0x0A); spi_data(0x82);

    spi_cmd(0x13); delay(10);          // NORON
    spi_cmd(0x21);                     // INVON
    spi_cmd(0x29); delay(10);          // DISPON
    SPI.endTransaction();

    // ── Backlight ON ───────────────────────────────────────────────
    digitalWrite(PIN_BL, HIGH);

    // ── Boot sweep animation ──────────────────────────────────────
    // Every power-on / reboot plays a visible sweep so the restart
    // (e.g. serial "reboot" command) is confirmed on screen.
    boot_sweep_animation();

    // ── LVGL core ─────────────────────────────────────────────────
    lv_init();

    // Draw buffer (40-line deep)
    lv_disp_draw_buf_init(&disp_buf, buf, nullptr, DISP_W * 40);

    // Display driver
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res  = DISP_W;
    disp_drv.ver_res  = DISP_H;
    disp_drv.flush_cb = disp_flush;
    disp_drv.draw_buf = &disp_buf;
    lv_disp_drv_register(&disp_drv);

    // ── Styles ─────────────────────────────────────────────────────
    // SimSun 16 — dim grey-blue for field names / column headers
    lv_style_init(&style_title);
    lv_style_set_text_font(&style_title, &my_font_16);
    lv_style_set_text_color(&style_title, lv_color_make(0x88, 0x99, 0xBB));

    // SimSun 16 — soft white-blue for data values
    lv_style_init(&style_label);
    lv_style_set_text_font(&style_label, &my_font_16);
    lv_style_set_text_color(&style_label, kValueColor);

    // Montserrat 14 for numeric data
    lv_style_init(&style_value);
    lv_style_set_text_font(&style_value, &lv_font_montserrat_14);
    lv_style_set_text_color(&style_value, kValueColor);

    // Status OK (green)
    lv_style_init(&style_status_ok);
    lv_style_set_text_font(&style_status_ok, &my_font_16);
    lv_style_set_text_color(&style_status_ok, lv_palette_main(LV_PALETTE_GREEN));

    // Status WARN (yellow)
    lv_style_init(&style_status_warn);
    lv_style_set_text_font(&style_status_warn, &my_font_16);
    lv_style_set_text_color(&style_status_warn, lv_palette_main(LV_PALETTE_YELLOW));

    // ── Build UI ──────────────────────────────────────────────────
    build_ui();

    // Render initial content (multiple timer ticks to flush all buffer chunks)
    for (int i = 0; i < 12; i++) {
        lv_timer_handler();
        delay(5);
    }

    display_ready = true;
    return true;
}

void display_set_gateway_name(const char *name) {
    if (!display_ready) return;
    lv_label_set_text(gw_name_label, name ? name : "");
}

void display_set_gateway_status(bool wifi, bool mqtt) {
    if (!display_ready) return;

    // Always refresh, not just on change — LVGL dirty-area may not trigger flush
    wifi_ok = wifi;
    mqtt_ok = mqtt;

    lv_label_set_text(gw_wifi_label, wifi ? "Connected" : "Offline");
    lv_obj_remove_style(gw_wifi_label,
                        wifi ? &style_status_warn : &style_status_ok, 0);
    lv_obj_add_style(gw_wifi_label,
                     wifi ? &style_status_ok : &style_status_warn, 0);

    lv_label_set_text(gw_mqtt_label, mqtt ? "Connected" : "Offline");
    lv_obj_remove_style(gw_mqtt_label,
                        mqtt ? &style_status_warn : &style_status_ok, 0);
    lv_obj_add_style(gw_mqtt_label,
                     mqtt ? &style_status_ok : &style_status_warn, 0);

    // Force full-screen invalidation & immediate refresh
    lv_obj_invalidate(lv_scr_act());
    lv_refr_now(lv_disp_get_default());
}

void display_set_gateway_network(const char *ip, int rssi) {
    if (!display_ready) return;

    if (strncmp(current_ip, ip, sizeof(current_ip)) != 0) {
        snprintf(current_ip, sizeof(current_ip), "%s", ip);
        lv_label_set_text(gw_ip_label, current_ip);
    }
    if (current_rssi != rssi) {
        current_rssi = rssi;
        char buf[24];
        snprintf(buf, sizeof(buf), "%d dBm", rssi);
        lv_label_set_text(gw_rssi_label, buf);
    }
}

void display_upsert_node(const DisplayNodeData &node) {
    if (!display_ready) return;

    // Find existing slot or first free slot
    int slot = -1;
    for (size_t i = 0; i < kMaxNodeRows; ++i) {
        if (row_ids[i] == node.device_id) {
            slot = static_cast<int>(i);
            break;
        }
        if (row_ids[i] == 0 && slot == -1) {
            slot = static_cast<int>(i);
        }
    }
    if (slot < 0) return;  // all slots full

    row_ids[slot] = node.device_id;

    // Update row labels
    char buf[16];

    snprintf(buf, sizeof(buf), "%u", node.device_id);
    lv_label_set_text(rows[slot].id, buf);

    lv_label_set_text(rows[slot].name, node_name_for_id(node.device_id));

    snprintf(buf, sizeof(buf), "%.1f\xC2\xB0" "C", node.temperature);
    lv_label_set_text(rows[slot].temp, buf);

    snprintf(buf, sizeof(buf), "%u%%", node.humidity);
    lv_label_set_text(rows[slot].hum, buf);

    snprintf(buf, sizeof(buf), "%.2fV", node.battery_mv / 1000.0f);
    lv_label_set_text(rows[slot].bat, buf);

    // Hide "no nodes" placeholder
    if (no_nodes_label) {
        lv_obj_add_flag(no_nodes_label, LV_OBJ_FLAG_HIDDEN);
    }

    // Update node count on gateway page
    snprintf(buf, sizeof(buf), "%d", active_node_count());
    lv_label_set_text(gw_nodes_label, buf);
}

void display_update() {
    if (!display_ready) return;

    // Auto-switch tab every kTabSwitchIntervalMs (button hardware not yet fitted)
    const uint32_t now = millis();
    if (now - last_tab_switch_ms >= kTabSwitchIntervalMs) {
        last_tab_switch_ms = now;
        current_page = (current_page == 0) ? 1 : 0;
        // LV_ANIM_OFF: avoid animation delay that may not finish in one tick
        lv_tabview_set_act(tabview, current_page, LV_ANIM_OFF);

        // Force immediate full-screen refresh so content switches right away
        lv_obj_invalidate(lv_scr_act());
        for (int i = 0; i < 4; i++) {
            lv_timer_handler();
            delay(2);
        }
        return;
    }

    // poll_button();   // uncomment once TAB_BUTTON hardware is fitted
    lv_timer_handler();
}
