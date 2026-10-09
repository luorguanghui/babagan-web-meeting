// Project-owned per-frame ABI. OpenH264 is BSD-2-Clause; see distributed LICENSE.
#include <codec_api.h>
#include <cstdint>
#include <cmath>
#include <memory>
#include <vector>

namespace {
struct Encoder {
  ISVCEncoder* codec = nullptr;
  int width = 0, height = 0;
  int bitrate = 0;
  bool key = false;
  std::vector<uint8_t> input, output;
  ~Encoder() {
    if (codec) { codec->Uninitialize(); WelsDestroySVCEncoder(codec); }
  }
};
std::unique_ptr<Encoder> encoders[8];
Encoder* find(int handle) {
  return handle > 0 && handle <= 8 ? encoders[handle - 1].get() : nullptr;
}
}

extern "C" {
static int create_encoder(int width, int height, int fps, int bitrate, int threads, EUsageType usage) {
  if (width < 16 || height < 16 || width > 3840 || height > 2160 ||
      (width & 1) || (height & 1) || fps < 1 || fps > 60 ||
      bitrate < 100000 || bitrate > 40000000 || threads < 1 || threads > 4) return 0;
#ifndef __EMSCRIPTEN_PTHREADS__
  if (threads != 1) return 0;
#endif
  int slot = 0;
  while (slot < 8 && encoders[slot]) ++slot;
  if (slot == 8) return 0;
  auto instance = std::make_unique<Encoder>();
  if (WelsCreateSVCEncoder(&instance->codec) != 0) return 0;
  int trace = WELS_LOG_ERROR;
  instance->codec->SetOption(ENCODER_OPTION_TRACE_LEVEL, &trace);
  SEncParamExt params = {};
  if (instance->codec->GetDefaultParams(&params) != 0) return 0;
  params.iUsageType = usage;
  params.iPicWidth = width;
  params.iPicHeight = height;
  params.fMaxFrameRate = fps;
  params.iTargetBitrate = bitrate;
  params.iMaxBitrate = bitrate;
  params.iRCMode = RC_BITRATE_MODE;
  params.iComplexityMode = LOW_COMPLEXITY;
  params.iTemporalLayerNum = 1;
  params.iSpatialLayerNum = 1;
  params.uiIntraPeriod = fps * 2;
  params.bEnableFrameSkip = false;
  params.iMultipleThreadIdc = threads;
  params.bUseLoadBalancing = threads > 1;
  params.bEnableDenoise = false;
  params.bEnableAdaptiveQuant = false;
  params.bEnableBackgroundDetection = false;
  params.bEnableSceneChangeDetect = true;
  params.iEntropyCodingModeFlag = 0;
  auto& layer = params.sSpatialLayers[0];
  layer.iVideoWidth = width;
  layer.iVideoHeight = height;
  layer.fFrameRate = fps;
  layer.iSpatialBitrate = bitrate;
  layer.iMaxSpatialBitrate = bitrate;
  layer.uiProfileIdc = PRO_BASELINE;
  layer.uiLevelIdc = LEVEL_4_2;
  layer.sSliceArgument.uiSliceMode = threads > 1 ? SM_FIXEDSLCNUM_SLICE : SM_SINGLE_SLICE;
  layer.sSliceArgument.uiSliceNum = threads;
  if (instance->codec->InitializeExt(&params) != 0) return 0;
  instance->width = width;
  instance->height = height;
  instance->bitrate = bitrate;
  instance->input.resize(width * height * 3 / 2);
  instance->output.reserve(2 * 1024 * 1024);
  encoders[slot] = std::move(instance);
  return slot + 1;
}
int screen_create(int width, int height, int fps, int bitrate, int threads) {
  return create_encoder(width, height, fps, bitrate, threads, SCREEN_CONTENT_REAL_TIME);
}
int screen_create_video(int width, int height, int fps, int bitrate, int threads) {
  return create_encoder(width, height, fps, bitrate, threads, CAMERA_VIDEO_REAL_TIME);
}
uint8_t* screen_input(int handle) {
  auto* encoder = find(handle);
  return encoder ? encoder->input.data() : nullptr;
}
int screen_encode(int handle, double timestamp_ms, int force_key) {
  auto* encoder = find(handle);
  if (!encoder || !std::isfinite(timestamp_ms) || timestamp_ms < 0 || timestamp_ms > 9007199254740.0) return -1;
  encoder->output.clear();
  encoder->key = false;
  if (force_key && encoder->codec->ForceIntraFrame(true) != 0) return -2;
  SSourcePicture picture = {};
  picture.iColorFormat = videoFormatI420;
  picture.iPicWidth = encoder->width;
  picture.iPicHeight = encoder->height;
  picture.iStride[0] = encoder->width;
  picture.iStride[1] = picture.iStride[2] = encoder->width / 2;
  picture.pData[0] = encoder->input.data();
  picture.pData[1] = picture.pData[0] + encoder->width * encoder->height;
  picture.pData[2] = picture.pData[1] + encoder->width * encoder->height / 4;
  picture.uiTimeStamp = static_cast<int64_t>(timestamp_ms);
  SFrameBSInfo info = {};
  if (encoder->codec->EncodeFrame(&picture, &info) != 0) return -3;
  if (info.eFrameType == videoFrameTypeSkip || info.iFrameSizeInBytes == 0) return 0;
  if (info.iFrameSizeInBytes < 0 || info.iFrameSizeInBytes > 2 * 1024 * 1024) return -4;
  for (int index = 0; index < info.iLayerNum; ++index) {
    auto& layer = info.sLayerInfo[index];
    int length = 0;
    for (int nal = 0; nal < layer.iNalCount; ++nal) length += layer.pNalLengthInByte[nal];
    if (length < 0 || encoder->output.size() + length > 2 * 1024 * 1024) return -4;
    encoder->output.insert(encoder->output.end(), layer.pBsBuf, layer.pBsBuf + length);
  }
  encoder->key = info.eFrameType == videoFrameTypeIDR;
  return encoder->output.empty() ? 0 : 1;
}
uint8_t* screen_output(int handle) { auto* e = find(handle); return e ? e->output.data() : nullptr; }
int screen_size(int handle) { auto* e = find(handle); return e ? e->output.size() : 0; }
int screen_key(int handle) { auto* e = find(handle); return e && e->key ? 1 : 0; }
int screen_set_bitrate(int handle, int bitrate) {
  auto* e = find(handle);
  if (!e || bitrate < 100000 || bitrate > 40000000) return -1;
  // Update ceilings before raising the target, after lowering it. OpenH264
  // validates the target against the spatial ceiling on every SetOption.
  SBitrateInfo info = { SPATIAL_LAYER_ALL, bitrate };
  if (bitrate < e->bitrate && e->codec->SetOption(ENCODER_OPTION_BITRATE, &info) != 0) return -2;
  SBitrateInfo layer = { SPATIAL_LAYER_0, bitrate };
  if (e->codec->SetOption(ENCODER_OPTION_MAX_BITRATE, &layer) != 0) return -3;
  if (e->codec->SetOption(ENCODER_OPTION_MAX_BITRATE, &info) != 0) return -4;
  if (bitrate >= e->bitrate && e->codec->SetOption(ENCODER_OPTION_BITRATE, &info) != 0) return -5;
  e->bitrate = bitrate;
  return 0;
}
void screen_destroy(int handle) { if (find(handle)) encoders[handle - 1].reset(); }
}
