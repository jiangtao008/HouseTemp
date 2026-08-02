/**
 * Raw SPI test for ST7789 — bypasses TFT_eSPI entirely.
 * Sends init commands and pixel data directly via Arduino SPI.
 */
#pragma once

#include <Arduino.h>
#include <SPI.h>

#define PIN_BL    7
#define PIN_DC    8
#define PIN_RST   9
#define PIN_CS   10
#define PIN_MOSI 11
#define PIN_SCLK 12

static void write_cmd(uint8_t cmd) {
  digitalWrite(PIN_DC, LOW);
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(cmd);
  digitalWrite(PIN_CS, HIGH);
}

static void write_data(uint8_t data) {
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(data);
  digitalWrite(PIN_CS, HIGH);
}

static void spi_diagnostic() {
  Serial.begin(115200);
  delay(500);

  // Set up pins
  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH);  // backlight on

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

  // Init SPI: 10 MHz, mode 0
  SPI.begin(PIN_SCLK, -1, PIN_MOSI, -1);
  SPI.beginTransaction(SPISettings(10000000, MSBFIRST, SPI_MODE0));

  // --- ST7789 init sequence (same as TFT_eSPI) ---
  write_cmd(0x01);  // SWRESET
  delay(150);

  write_cmd(0x11);  // SLPOUT
  delay(120);

  write_cmd(0x36);  // MADCTL
  write_data(0x00); // RGB, normal orientation

  write_cmd(0x3A);  // COLMOD
  write_data(0x55); // 16-bit color (RGB565)

  // RAMCTRL — controls byte order (same as TFT_eSPI uses)
  write_cmd(0xB6);
  write_data(0x0A);
  write_data(0x82);

  write_cmd(0x13);  // NORON (normal mode on)
  delay(10);

  write_cmd(0x29);  // DISPON
  delay(10);

  // --- Test A: RED (0xF8 0x00 = high byte first, standard) ---
  write_cmd(0x2A);  // CASET: col 0..239
  write_data(0x00); write_data(0x00);
  write_data(0x00); write_data(0xEF);
  write_cmd(0x2B);  // PASET: row 0..319
  write_data(0x00); write_data(0x00);
  write_data(0x01); write_data(0x3F);
  write_cmd(0x2C);  // RAMWR

  // Fill upper half (rows 0-159) with RED: high byte first
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (uint32_t i = 0; i < 240 * 160; i++) {
    SPI.transfer(0xF8);  // high byte of RED (0xF800)
    SPI.transfer(0x00);  // low byte
  }
  digitalWrite(PIN_CS, HIGH);

  delay(500);

  // --- Test B: send RED with low byte first ---
  write_cmd(0x2A);
  write_data(0x00); write_data(0x00);
  write_data(0x00); write_data(0xEF);
  write_cmd(0x2B);
  write_data(0x00); write_data(0xA0);  // row 160
  write_data(0x01); write_data(0x3F);  // to 319
  write_cmd(0x2C);

  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (uint32_t i = 0; i < 240 * 160; i++) {
    SPI.transfer(0x00);  // low byte first
    SPI.transfer(0xF8);  // high byte
  }
  digitalWrite(PIN_CS, HIGH);

  SPI.endTransaction();
}

static void loop_idle() {
  delay(100);
}
