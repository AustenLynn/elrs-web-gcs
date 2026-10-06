#!/usr/bin/env bash
# Started by MediaMTX (runOnInit): capture the FPV receiver's HDMI output through the
# USB dongle (MJPEG), encode H.264 on the Pi 4's hardware encoder, publish to MediaMTX.
# Settings come from /etc/gcs/video.env. VIDEO_SOURCE=test uses a generated test pattern
# instead of the dongle (to check the video path without the receiver).
set -euo pipefail
: "${VIDEO_DEVICE:=/dev/video0}" "${VIDEO_SIZE:=1280x720}" "${VIDEO_FPS:=30}" "${VIDEO_BITRATE:=2500k}" "${VIDEO_SOURCE:=device}"

if [[ "$VIDEO_SOURCE" == "test" ]]; then
  input=(-re -f lavfi -i "testsrc2=size=${VIDEO_SIZE}:rate=${VIDEO_FPS}")
else
  input=(-fflags nobuffer -f v4l2 -input_format mjpeg -video_size "$VIDEO_SIZE" -framerate "$VIDEO_FPS" -i "$VIDEO_DEVICE")
fi

exec ffmpeg -hide_banner -loglevel warning "${input[@]}" \
  -vf format=yuv420p -c:v h264_v4l2m2m -b:v "$VIDEO_BITRATE" -g "$VIDEO_FPS" -bf 0 \
  -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT:-8554}/${MTX_PATH:-fpv}"
