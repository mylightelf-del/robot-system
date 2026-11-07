// Metro 설정: 서버 저장소의 도메인 모듈(src/lib/domain/*: 타입·상태 라벨·명령 라벨)을 앱에서 그대로 쓴다.
// 그 폴더는 외부 패키지를 쓰지 않고 타입 전용 import 만 하므로 번들에 안전하게 포함된다.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../src/lib/domain")];
module.exports = config;
// 앱 코드의 패키지는 항상 mobile/node_modules 에서만 찾는다(상위 저장소의 node_modules 와 섞이지 않게).
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
