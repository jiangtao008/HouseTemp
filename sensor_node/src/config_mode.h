#pragma once

// 非低功耗配置模式：当 CONFIG_IO_PIN 上电为高电平时进入。
// 不返回：内部死循环等待串口命令，直到收到 reboot 才重启并回到正常流程。
void enter_config_mode();
