/**
 * Minimal LVGL + TFT_eSPI test for ST7789 240x320 on ESP32-S3
 *
 * 1.  Direct TFT fillScreen test → confirms SPI / pins / display work
 * 2.  LVGL init → draws a simple label with default font (Montserrat 12)
 * 3.  Reports all steps over Serial so you know where it fails
 */
#pragma once

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <lvgl.h>

// ── Display configuration (match your wiring) ──────────────────────────────
#define TFT_BL_PIN    7

// ── Globals ────────────────────────────────────────────────────────────────
static TFT_eSPI tft;
static lv_disp_draw_buf_t disp_buf;
static lv_color_t buf[240 * 40];          // 40-line buffer
static lv_disp_drv_t    disp_drv;

// ── LVGL flush callback ─────────────────────────────────────────────────────
static void my_disp_flush(lv_disp_drv_t *disp, const lv_area_t *area,
                           lv_color_t *color_p) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;

  Serial.printf("[FLUSH] %u×%u @(%u,%u)\n", w, h, area->x1, area->y1);

  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  // 关键: swap=false!
  // ESP32-S3 上 swap=true 会破坏字节序，导致除黑白外的颜色全错
  tft.pushColors((uint16_t *)color_p, w * h, false);
  tft.endWrite();

  lv_disp_flush_ready(disp);
}

// ── Entry point ─────────────────────────────────────────────────────────────
void test_lvgl_main() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n=== LVGL MINIMAL TEST ===");

  // ── Step 1: Direct TFT test ──────────────────────────────────────────────
  Serial.println("Step 1: TFT_eSPI direct test …");
  pinMode(TFT_BL_PIN, OUTPUT);
  digitalWrite(TFT_BL_PIN, HIGH);        // backlight on now

  // Force a hardware reset pulse before init
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_RST, LOW);
  delay(50);
  digitalWrite(TFT_RST, HIGH);
  delay(50);

  tft.init();
  tft.setRotation(0);                    // portrait 240×320

  // ── Override TFT_eSPI's init to match the working diagnostic ──
  // TFT_eSPI's ST7789 init sends 0xB6 TWICE, the second call (0x00,0xE0)
  // overrides the first (0x0A,0x82) and enables BGR mode in the panel
  // interface. We reset to RGB mode here to match LVGL's RGB565 format.
  tft.writecommand(0x36);   // MADCTL
  tft.writedata(0x00);      // RGB, normal orientation

  tft.writecommand(0xB6);   // RAMCTRL (override the 2nd call)
  tft.writedata(0x0A);
  tft.writedata(0x82);

  tft.writecommand(0x21);   // INVON (display inversion on)
  delay(10);

  tft.fillScreen(TFT_RED);    Serial.println("  RED");    delay(800);
  tft.fillScreen(TFT_GREEN);  Serial.println("  GREEN");  delay(800);
  tft.fillScreen(TFT_BLUE);   Serial.println("  BLUE");   delay(800);
  tft.fillScreen(TFT_WHITE);  Serial.println("  WHITE");  delay(800);
  tft.fillScreen(TFT_BLACK);  Serial.println("  BLACK → if you saw R/G/B/W the TFT works");

  // If you don't see the colours above, STOP here and check your wiring.
  delay(1000);

  // ── Step 2: LVGL init ────────────────────────────────────────────────────
  Serial.println("Step 2: lv_init() …");
  lv_init();

  Serial.println("Step 3: draw buffer …");
  lv_disp_draw_buf_init(&disp_buf, buf, NULL, 240 * 40);

  Serial.println("Step 4: display driver …");
  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res  = 240;
  disp_drv.ver_res  = 320;
  disp_drv.flush_cb = my_disp_flush;
  disp_drv.draw_buf = &disp_buf;

  lv_disp_drv_register(&disp_drv);
  Serial.println("  driver registered");

  // ── Step 5: A trivial UI ────────────────────────────────────────────────
  Serial.println("Step 5: create UI …");

  // Blue background so we can tell LVGL rendered something
  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_make(0x00, 0x40, 0x80), 0);
  lv_obj_set_style_bg_opa(lv_scr_act(), LV_OPA_COVER, 0);

  lv_obj_t *label = lv_label_create(lv_scr_act());
  lv_label_set_text(label, "Hello LVGL!");
  lv_obj_align(label, LV_ALIGN_CENTER, 0, 0);

  // ── Step 6: Force a render ───────────────────────────────────────────────
  Serial.println("Step 6: lv_timer_handler() x3 …");
  lv_timer_handler();
  delay(50);
  lv_timer_handler();
  delay(50);
  lv_timer_handler();

  Serial.println("Step 7: invalidate + one more flush …");
  lv_obj_invalidate(lv_scr_act());
  lv_timer_handler();

  Serial.println("=== TEST DONE – screen should show text on blue bg ===");
}

// ── Idle (call from loop) ───────────────────────────────────────────────────
void test_lvgl_loop() {
  lv_timer_handler();
  delay(5);
}
