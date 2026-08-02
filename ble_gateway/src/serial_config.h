#pragma once

void serial_config_update();
// 通知上位机：设备已完成启动（用于重启后确认设备已回到在线状态）。
void serial_config_notify_boot();
