#!/usr/bin/env bash
# 打手机端 APK。
#
# 不用 Gradle：这个外壳只有一个 Activity、三个 XML 资源，没有第三方依赖，
# 拉一套 Gradle + AGP 进来要几百 MB 和几分钟的配置解析，而这里四步就完事。
#
# 需要：JDK 17、Android SDK 的 build-tools 与 platform android-34。
#   JAVA_HOME / ANDROID_HOME 没设的话，用下面这两个默认值。
#
# 用法：bash android/build-apk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAVA_HOME="${JAVA_HOME:-D:/toolchain/jdk-17.0.20.1+1}"
ANDROID_HOME="${ANDROID_HOME:-D:/toolchain/android-sdk}"
# d8.bat / apksigner.bat 是从 .bat 里读环境变量的，必须导出，
# 只在 bash 里赋值对它们不可见。
export JAVA_HOME ANDROID_HOME
BUILD_TOOLS="$ANDROID_HOME/build-tools/34.0.0"
PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"

for tool in "$BUILD_TOOLS/aapt2.exe" "$BUILD_TOOLS/d8.bat" "$BUILD_TOOLS/zipalign.exe" "$BUILD_TOOLS/apksigner.bat"; do
  [ -f "$tool" ] || { echo "缺工具：$tool（先装 build-tools;34.0.0）" >&2; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺 android.jar：$PLATFORM（先装 platforms;android-34）" >&2; exit 1; }

SRC="$ROOT/android/app/src/main"
OUT="$ROOT/dist-android"
WORK="$OUT/build"
APK_UNSIGNED="$WORK/app-unsigned.apk"
APK_ALIGNED="$WORK/app-aligned.apk"
APK_FINAL="$OUT/DaiganOps.apk"
KEYSTORE="$ROOT/android/daigan-release.jks"
KEY_ALIAS="daigan"

rm -rf "$WORK"
mkdir -p "$WORK/res" "$WORK/gen" "$WORK/classes" "$OUT"

echo "[1/5] 编译资源"
"$BUILD_TOOLS/aapt2.exe" compile --dir "$SRC/res" -o "$WORK/res/res.zip"

echo "[2/5] 链接资源"
"$BUILD_TOOLS/aapt2.exe" link \
  -o "$APK_UNSIGNED" \
  -I "$PLATFORM" \
  --manifest "$SRC/AndroidManifest.xml" \
  --java "$WORK/gen" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --auto-add-overlay \
  "$WORK/res/res.zip"

echo "[3/5] 编译 Java"
# JDK 12 之后不再接受 -bootclasspath，直接让 android.jar 走 classpath 即可：
# 它自带 java.* 的桩代码，编译期需要的就是这些签名。
"$JAVA_HOME/bin/javac" -encoding UTF-8 --release 11 \
  -classpath "$PLATFORM" \
  -d "$WORK/classes" \
  $(find "$SRC/java" -name '*.java') \
  $(find "$WORK/gen" -name '*.java')

echo "[4/5] 转 dex"
"$BUILD_TOOLS/d8.bat" --release --min-api 26 --output "$WORK" \
  $(find "$WORK/classes" -name '*.class')

echo "[5/5] 打包、对齐、签名"
# 把 dex 塞进 aapt2 已经写好的资源包里
cd "$WORK" && "$JAVA_HOME/bin/jar" uf "$APK_UNSIGNED" classes.dex && cd "$ROOT"

"$BUILD_TOOLS/zipalign.exe" -f -p 4 "$APK_UNSIGNED" "$APK_ALIGNED"

# 没有正式签名证书时现造一个自签的：手机装 APK 不校验 CA，
# 只要求「更新时签名一致」，所以这一份要留着，别每次重新生成。
if [ ! -f "$KEYSTORE" ]; then
  echo "     生成自签证书 $KEYSTORE（请提交保存，换掉它就无法覆盖安装）"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass daigan-ops -keypass daigan-ops \
    -dname "CN=DAIGANG, OU=Ops, O=DAIGANG, L=Local, C=CN" >/dev/null 2>&1
fi

"$BUILD_TOOLS/apksigner.bat" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass pass:daigan-ops --key-pass pass:daigan-ops \
  --out "$APK_FINAL" "$APK_ALIGNED"

"$BUILD_TOOLS/apksigner.bat" verify --print-certs "$APK_FINAL" | head -4

rm -rf "$WORK"
ls -lh "$APK_FINAL"
echo "完成：$APK_FINAL"
