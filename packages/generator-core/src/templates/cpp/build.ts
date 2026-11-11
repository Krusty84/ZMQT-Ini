/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export function renderCppBuild(
  name: string,
  cppzmqVersion: string,
  roles: readonly string[],
  workers = false,
): string {
  const targets = roles.map((role) => `app_${role}`);
  return `cmake_minimum_required(VERSION 3.24)
project(${name} LANGUAGES C CXX)

include(FetchContent)

# libzmq 4.3.5 declares an older CMake policy version.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
set(BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(BUILD_STATIC ON CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WITH_PERF_TOOL OFF CACHE BOOL "" FORCE)
set(WITH_DOC OFF CACHE BOOL "" FORCE)
set(WITH_DOCS OFF CACHE BOOL "" FORCE)
set(WITH_LIBBSD OFF CACHE BOOL "" FORCE)
set(WITH_LIBSODIUM OFF CACHE BOOL "" FORCE)
set(ENABLE_DRAFTS OFF CACHE BOOL "" FORCE)
set(ENABLE_WS OFF CACHE BOOL "" FORCE)
set(ENABLE_CURVE OFF CACHE BOOL "" FORCE)
set(CPPZMQ_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)

FetchContent_Declare(ZeroMQ
  URL https://github.com/zeromq/libzmq/releases/download/v4.3.5/zeromq-4.3.5.tar.gz
  URL_HASH SHA256=6653ef5910f17954861fe72332e68b03ca6e4d9c7160eb3a8de5a5a913bfab43
  FIND_PACKAGE_ARGS 4.3.5 EXACT CONFIG
)
FetchContent_Declare(cppzmq
  URL https://codeload.github.com/zeromq/cppzmq/tar.gz/refs/tags/v${cppzmqVersion}
  URL_HASH SHA256=0fff4ff311a7c88fdb76fceefba0e180232d56984f577db371d505e4d4c91afd
  FIND_PACKAGE_ARGS ${cppzmqVersion} EXACT CONFIG
)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  FIND_PACKAGE_ARGS 3.12.0 EXACT CONFIG
)
FetchContent_MakeAvailable(ZeroMQ cppzmq nlohmann_json)

add_library(zmqt_runtime STATIC zmqt_runtime.cpp message_codec.cpp)
if(TARGET libzmq-static)
  target_link_libraries(zmqt_runtime PUBLIC cppzmq-static nlohmann_json::nlohmann_json)
else()
  target_link_libraries(zmqt_runtime PUBLIC cppzmq nlohmann_json::nlohmann_json)
endif()
${workers ? "find_package(Threads REQUIRED)\ntarget_link_libraries(zmqt_runtime PUBLIC Threads::Threads)\n" : ""}
${targets.map((target) => `add_executable(${target} ${target}.cpp)\ntarget_link_libraries(${target} PRIVATE zmqt_runtime)`).join("\n")}
set_target_properties(zmqt_runtime ${targets.join(" ")} PROPERTIES
  CXX_STANDARD 23
  CXX_STANDARD_REQUIRED YES
  CXX_EXTENSIONS OFF
)
`;
}
