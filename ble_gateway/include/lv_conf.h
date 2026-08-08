#ifndef LV_CONF_H
#define LV_CONF_H

#include <stdint.h>


/* Color depth: 16-bit RGB565 */
#define LV_COLOR_DEPTH 16

/* LVGL uses a static internal-RAM pool (see lv_mem.c: without LV_MEM_POOL_ALLOC
   it allocates a fixed array in .bss). Do NOT point this at ps_malloc: the
   default esp32-s3-devkitc-1 module has no PSRAM, and ps_malloc() would return
   NULL there, breaking every LVGL allocation. 32 KB out of 320 KB internal RAM
   is a fair price for running on any ESP32-S3 variant. */
#define LV_MEM_SIZE (32 * 1024)

/* Max FPS */
#define LV_DISP_DEF_REFR_PERIOD 30

/* Use custom tick from millis() */
#define LV_TICK_CUSTOM 1
#define LV_TICK_CUSTOM_INCLUDE <Arduino.h>
#define LV_TICK_CUSTOM_SYS_TIME_EXPR (millis())

/* Enable the default theme */
#define LV_USE_THEME_DEFAULT 1

/* Enable fonts */
#define LV_FONT_MONTSERRAT_12 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 0

/* CJK font — custom generated (my_font_16.c), no built-in SimSun needed */
#define LV_FONT_SIMSUN_16_CJK 0

/* Enable widgets we use */
#define LV_USE_LABEL 1
#define LV_USE_BTN 1
#define LV_USE_TABVIEW 1
#define LV_USE_CONT 1

/* Enable animations */
#define LV_USE_ANIMATION 1

/* Logging (enable for debugging LVGL issues) */
#define LV_USE_LOG 1

#define LV_LOG_LEVEL LV_LOG_LEVEL_INFO
#define LV_LOG_PRINTF 1

/* Use built-in sprintf */
#define LV_SPRINTF_CUSTOM 0

/* GPU settings — none */
#define LV_USE_GPU_STM32_DMA2D 0
#define LV_USE_GPU_NXP_PXP 0
#define LV_USE_GPU_NXP_VG_LITE 0

/* File system — not needed for this project */
#define LV_USE_FILESYSTEM 0

/* Enable snapshot for page capture (optional) */
#define LV_USE_SNAPSHOT 0

#endif /* LV_CONF_H */
