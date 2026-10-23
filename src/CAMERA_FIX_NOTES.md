# Camera update

This build changes BrickMotion's automatic assembly camera to behave more like the supplied reference videos.

## What changed

- The build camera now anchors strongly to the finished model instead of chasing each incoming part.
- Automatic target and zoom changes are damped to remove twitchy micro-reframing.
- The camera frames only the model or submodel being assembled; pieces waiting on the floor are not kept in the shot and fly in from outside it.
- Each submodel holds the camera from its first piece until its last piece has landed.
- Build-time azimuth drift is small; larger camera movement is reserved for the hero reveal.
- Camera framing uses a configurable photographic lens/sensor model.
- Preview and MP4 export use the exact same camera settings.

## New camera controls

Video > Studio appearance > Camera settings now includes:

- Lens (mm)
- Sensor width (mm)
- Build azimuth
- Build elevation
- Frame margin
- Build drift
- Target lock
- Camera damping
- Submodel focus (100% = only the submodel; lower keeps the main model in view)
- Hero orbit degrees
- Hero elevation
- Hero margin

Presets: Reference, Closer, Stable overhead.

## Reference preset defaults

- 52 mm lens
- 36 mm sensor
- 16 degree azimuth
- 60 degree elevation
- 1.10 frame margin
- 86% target lock
- 82% damping
- 100% submodel focus
- 5 degree build drift
- 120 degree hero orbit
- 30 degree hero elevation

These are designed for a calm, tripod-like assembly shot followed by a more dynamic completed-model reveal.
