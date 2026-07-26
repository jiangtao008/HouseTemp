/**
 * LVGL on raw SPI — bypasses TFT_eSPI entirely.
 * Uses the init sequence verified in the diagnostic test.
 */
#pragma once

#include <Arduino.h>
#include <SPI.h>
#include <lvgl.h>

// ── Pin config ──────────────────────────────────────────────────────────
#define PIN_BL    7
#define PIN_DC    8
#define PIN_RST   9
#define PIN_CS   10
#define PIN_MOSI 11
#define PIN_SCLK 12

// ── LVGL buffer ────────────────────────────────────────────────────────
static lv_disp_draw_buf_t disp_buf;
static lv_color_t buf[240 * 40];
static lv_disp_drv_t    disp_drv;

// ── Low-level SPI helpers ──────────────────────────────────────────────
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

static void spi_data_bulk(const uint8_t *data, uint32_t len) {
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  while (len--) SPI.transfer(*data++);
  digitalWrite(PIN_CS, HIGH);
}

// ── Initialise display (matching the working diagnostic) ────────────────
static void display_hw_init() {
  // Backlight
  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);

  // Control pins
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

  // SPI bus: 20 MHz, mode 0, MSB first
  SPI.begin(PIN_SCLK, -1, PIN_MOSI, -1);
  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));

  // ── Init sequence (same as working diagnostic) ──
  spi_cmd(0x01); delay(150);         // SWRESET
  spi_cmd(0x11); delay(120);         // SLPOUT

  spi_cmd(0x36); spi_data(0x00);     // MADCTL = RGB
  spi_cmd(0x3A); spi_data(0x55);     // COLMOD = 16-bit

  spi_cmd(0xB6);                     // RAMCTRL
  spi_data(0x0A);
  spi_data(0x82);

  spi_cmd(0x13); delay(10);          // NORON
  spi_cmd(0x21);                     // INVON
  spi_cmd(0x29); delay(10);          // DISPON

  // CASET / PASET
  spi_cmd(0x2A); spi_data(0x00); spi_data(0x00); spi_data(0x00); spi_data(0xEF);
  spi_cmd(0x2B); spi_data(0x00); spi_data(0x00); spi_data(0x01); spi_data(0x3F);

  SPI.endTransaction();

  Serial.println("Display HW init done (raw SPI)");
}

// ── LVGL flush callback ────────────────────────────────────────────────
static void disp_flush(lv_disp_drv_t *disp, const lv_area_t *area,
                        lv_color_t *color_p) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;

  Serial.printf("[FLUSH] %u×%u @(%u,%u)\n", w, h, area->x1, area->y1);

  // Each lv_color_t is RGB565 in little-endian.  We send it high-byte-first
  // via SPI (which is MSB-first), so we write the bytes as-is from the
  // uint16_t array — the ESP32's little-endian memory layout means the first
  // byte in each 16-bit word is the LOW byte, but we need to send HIGH byte
  // first.  So we send byte 1 then byte 0 of each pixel.
  uint32_t total = w * h;
  auto *pixels = reinterpret_cast<uint16_t *>(color_p);

  spi_cmd(0x2A);  // CASET
  spi_data(area->x1 >> 8); spi_data(area->x1 & 0xFF);
  spi_data(area->x2 >> 8); spi_data(area->x2 & 0xFF);
  spi_cmd(0x2B);  // PASET
  spi_data(area->y1 >> 8); spi_data(area->y1 & 0xFF);
  spi_data(area->y2 >> 8); spi_data(area->y2 & 0xFF);
  spi_cmd(0x2C);  // RAMWR

  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (uint32_t i = 0; i < total; i++) {
    SPI.transfer(pixels[i] >> 8);   // high byte
    SPI.transfer(pixels[i] & 0xFF); // low byte
  }
  digitalWrite(PIN_CS, HIGH);

  lv_disp_flush_ready(disp);
}

// ── Entry point ─────────────────────────────────────────────────────────
void raw_lvgl_main() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== RAW SPI + LVGL TEST ===");

  // Direct fill test (raw SPI, no TFT_eSPI)
  display_hw_init();

  // Fill screen RED using raw SPI
  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
  spi_cmd(0x2A);
  spi_data(0x00); spi_data(0x00);
  spi_data(0x00); spi_data(0xEF);
  spi_cmd(0x2B);
  spi_data(0x00); spi_data(0x00);
  spi_data(0x01); spi_data(0x3F);
  spi_cmd(0x2C);

  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (uint32_t i = 0; i < 240 * 320; i++) {
    SPI.transfer(0xF8);  // high byte of RED (0xF800)
    SPI.transfer(0x00);
  }
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
  Serial.println("Full screen RED — seeing this?");
  delay(2000);

  // Fill screen GREEN
  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
  spi_cmd(0x2A);
  spi_data(0x00); spi_data(0x00);
  spi_data(0x00); spi_data(0xEF);
  spi_cmd(0x2B);
  spi_data(0x00); spi_data(0x00);
  spi_data(0x01); spi_data(0x3F);
  spi_cmd(0x2C);

  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (uint32_t i = 0; i < 240 * 320; i++) {
    SPI.transfer(0x07);  // GREEN (0x07E0)
    SPI.transfer(0xE0);
  }
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
  Serial.println("Full screen GREEN");
  delay(2000);

  // ── LVGL ──────────────────────────────────────────────────────────
  Serial.println("LVGL init …");
  lv_init();

  lv_disp_draw_buf_init(&disp_buf, buf, NULL, 240 * 40);

  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res  = 240;
  disp_drv.ver_res  = 320;
  disp_drv.flush_cb = disp_flush;
  disp_drv.draw_buf = &disp_buf;
  lv_disp_drv_register(&disp_drv);

  // UI: blue background + white label
  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_make(0x00, 0x40, 0x80), 0);
  lv_obj_set_style_bg_opa(lv_scr_act(), LV_OPA_COVER, 0);

  lv_obj_t *label = lv_label_create(lv_scr_act());
  lv_label_set_text(label, "Hello LVGL on raw SPI!");
  lv_obj_align(label, LV_ALIGN_CENTER, 0, 0);

  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
  lv_timer_handler();
  delay(50);
  lv_timer_handler();
  delay(50);
  lv_timer_handler();
  lv_obj_invalidate(lv_scr_act());
  lv_timer_handler();
  SPI.endTransaction();

  Serial.println("=== DONE ===");
}

void raw_lvgl_loop() {
  SPI.beginTransaction(SPISettings(20000000, MSBFIRST, SPI_MODE0));
  lv_timer_handler();
  SPI.endTransaction();
  delay(5);
}
