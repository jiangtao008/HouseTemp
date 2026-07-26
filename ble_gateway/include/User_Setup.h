// TFT_eSPI pin configuration for ST7789 240x320
#define ST7789_DRIVER      1

#define TFT_WIDTH          240
#define TFT_HEIGHT         320

#define TFT_CS             10
#define TFT_DC             8
#define TFT_RST            9
#define TFT_MOSI           11
#define TFT_SCLK           12
// TFT_BL is NOT defined here – backlight is controlled manually
// in display.cpp after the display content is ready, to avoid
// white flash at boot (the ST7789 init sequence would otherwise
// turn on the backlight via #ifdef TFT_BL before fillScreen).
//#define TFT_BL           7

#define SPI_FREQUENCY      20000000
#define SPI_READ_FREQUENCY 20000000
#define SPI_TOUCH_FREQUENCY 2500000

#define TFT_RGB_ORDER 0    // 强制使用 BGR 颜色顺序

// 不要定义 USE_HSPI_PORT！ESP32-S3 上默认使用 FSPI(SPI2)，
// 而 MOSI=11, SCLK=12 正是 FSPI 的 IOMUX 引脚。
// 定义 USE_HSPI_PORT 会让它用 SPI3(HSPI)，信号绕行 GPIO 矩阵，
// 经常导致初始化失败、白屏。
//#define USE_HSPI_PORT
