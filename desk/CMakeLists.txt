cmake_minimum_required(VERSION 3.16)
project(DeskApp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)       # Qt MOC：处理 Q_OBJECT 宏
set(CMAKE_AUTORCC ON)       # Qt 资源文件 (.qrc)
set(CMAKE_AUTOUIC ON)       # Qt UI 文件 (.ui)

# ====== Qt 配置 ======
# 指定 Qt 安装路径（macOS framework 版本）
set(CMAKE_PREFIX_PATH
    "/Users/jiangtao/qtSDK/5.15.18_macosx_build_universal_withoutweb"
    ${CMAKE_PREFIX_PATH}
)

# 查找 Qt5 模块
find_package(Qt5 REQUIRED COMPONENTS
    Core
    Gui
    Widgets
)

# ====== 源文件 ======
set(SOURCES
    src/main.cpp
    src/mainwindow.cpp
    src/serialport.cpp
    src/protocol.cpp
)

set(HEADERS
    src/mainwindow.h
    src/serialport.h
    src/protocol.h
)

# ====== 可执行目标 ======
add_executable(${PROJECT_NAME}
    ${SOURCES}
    ${HEADERS}
)

# ====== 链接 Qt 库 ======
target_link_libraries(${PROJECT_NAME} PRIVATE
    Qt5::Core
    Qt5::Gui
    Qt5::Widgets
)

# ====== 编译选项 ======
target_compile_options(${PROJECT_NAME} PRIVATE
    "-Wall"
    "-Wextra"
)

# ====== macOS 特有配置 ======
if(APPLE)
    set_target_properties(${PROJECT_NAME} PROPERTIES
        MACOSX_BUNDLE TRUE
        MACOSX_BUNDLE_BUNDLE_NAME "DeskApp"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    )
endif()
