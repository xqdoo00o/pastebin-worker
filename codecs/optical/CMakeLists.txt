# Pastebin Worker optical QR codec: QR-only, reader-only zxing-cpp with
# direct luminance input.
cmake_minimum_required(VERSION 3.16)

project(optical-codec CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ZXING_READERS ON)
set(ZXING_WRITERS OFF)
set(ZXING_C_API OFF)
set(ZXING_ENABLE_1D OFF)
set(ZXING_ENABLE_AZTEC OFF)
set(ZXING_ENABLE_DATAMATRIX OFF)
set(ZXING_ENABLE_MAXICODE OFF)
set(ZXING_ENABLE_PDF417 OFF)
set(ZXING_ENABLE_QRCODE ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Choose the type of build." FORCE)
endif()

option(OPTICAL_ENABLE_LTO "Enable link-time optimization for release artifacts" ON)
option(OPTICAL_ENABLE_SIMD "Compile the optical decoder with WebAssembly SIMD" ON)

set(OPTICAL_COMPILE_OPTIONS
    -sSUPPORT_LONGJMP=0
    $<$<COMPILE_LANGUAGE:CXX>:-fwasm-exceptions>)
if(OPTICAL_ENABLE_SIMD)
    list(APPEND OPTICAL_COMPILE_OPTIONS -msimd128)
endif()
if(OPTICAL_ENABLE_LTO)
    list(APPEND OPTICAL_COMPILE_OPTIONS -flto)
endif()
add_compile_options(${OPTICAL_COMPILE_OPTIONS})

set(OPTICAL_ZXING_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/zxing-cpp/core" CACHE PATH
    "Path to the zxing-cpp core source tree")
if(NOT EXISTS "${OPTICAL_ZXING_SOURCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "OPTICAL_ZXING_SOURCE_DIR is not a zxing-cpp core source tree: ${OPTICAL_ZXING_SOURCE_DIR}")
endif()
add_subdirectory("${OPTICAL_ZXING_SOURCE_DIR}" ${CMAKE_BINARY_DIR}/ZXing)

add_executable(optical_codec src/optical_codec.cpp)
target_link_libraries(optical_codec ZXing::ZXing)

set(OPTICAL_LINK_OPTIONS
    --bind
    -fwasm-exceptions
    -sSUPPORT_LONGJMP=0
    -sENVIRONMENT=worker
    -sFILESYSTEM=0
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sDYNAMIC_EXECUTION=0
    -sEXPORT_NAME=OpticalCodec
    -sINCOMING_MODULE_JS_API=locateFile,instantiateWasm
    "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
    -sEXPORTED_RUNTIME_METHODS=HEAPU8
    -sALLOW_MEMORY_GROWTH=1)
if(OPTICAL_ENABLE_SIMD)
    list(APPEND OPTICAL_LINK_OPTIONS -msimd128)
endif()
if(OPTICAL_ENABLE_LTO)
    list(APPEND OPTICAL_LINK_OPTIONS -flto)
endif()
target_link_options(optical_codec PRIVATE ${OPTICAL_LINK_OPTIONS})

target_compile_definitions(optical_codec PRIVATE ZXING_INTERNAL)

target_include_directories(optical_codec PRIVATE
    ${OPTICAL_ZXING_SOURCE_DIR}/src)
