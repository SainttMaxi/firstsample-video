import {
  AbsoluteFill,
  Audio,
  Sequence,
  Video,
  Img,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
  Easing,
  spring,
  staticFile,
} from 'remotion';

// ── TEXT OVERLAY ──
const TextOverlay = ({ text, style, position, startFrame, durationFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = frame - startFrame;

  const opacity = interpolate(
    localFrame,
    [0, 8, durationFrames - 8, durationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const translateY = interpolate(
    localFrame,
    [0, 12],
    [30, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }
  );

  const posMap = { top: '15%', center: '50%', bottom: '80%' };
  const top = posMap[position] || '50%';
  const transform = position === 'center'
    ? `translate(-50%, calc(-50% + ${translateY}px))`
    : `translate(-50%, ${translateY}px)`;

  const colors = {
    filled: { color: '#FFFFFF', WebkitTextStroke: 'none' },
    outline: { color: 'transparent', WebkitTextStroke: '3px #FFFFFF' },
    blue: { color: '#4D7BFF', WebkitTextStroke: 'none' },
  };
  const colorStyle = colors[style] || colors.filled;

  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: '50%',
        transform,
        opacity,
        textAlign: 'center',
        zIndex: 100,
        padding: '0 40px',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span
        style={{
          fontFamily: '"Bebas Neue", sans-serif',
          fontSize: 96,
          lineHeight: 0.92,
          letterSpacing: '0.02em',
          display: 'block',
          ...colorStyle,
          textShadow: style === 'filled' ? '0 4px 40px rgba(0,0,0,0.8)' : 'none',
          filter: style === 'blue' ? 'drop-shadow(0 0 20px rgba(77,123,255,0.6))' : 'none',
        }}
      >
        {text}
      </span>
    </div>
  );
};

// ── FLASH TRANSITION ──
const FlashTransition = ({ atFrame, durationFrames = 6 }) => {
  const frame = useCurrentFrame();
  const localFrame = frame - atFrame;
  if (localFrame < 0 || localFrame > durationFrames) return null;

  const opacity = interpolate(
    localFrame,
    [0, 2, durationFrames],
    [0.6, 0, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{ backgroundColor: '#ffffff', opacity, zIndex: 200, pointerEvents: 'none' }}
    />
  );
};

// ── WATERMARK ──
const Watermark = () => (
  <div style={{
    position: 'absolute', bottom: 40, left: 0, right: 0,
    textAlign: 'center', zIndex: 50,
    fontFamily: 'DM Sans, sans-serif',
    fontSize: 22, fontWeight: 300,
    color: 'rgba(255,255,255,0.15)',
    letterSpacing: '0.2em', textTransform: 'uppercase',
  }}>
    firstsample.co
  </div>
);

// ── ACCENT LINE ──
const AccentLine = () => (
  <div style={{
    position: 'absolute', top: 0, left: 0, right: 0,
    height: 4, zIndex: 150,
    background: 'linear-gradient(90deg, #2d5fff, #5d85ff)',
  }} />
);

// ── CLIP COMPONENT ──
const ClipSegment = ({ clip, startFrame, durationFrames, transition }) => {
  const frame = useCurrentFrame();
  const localFrame = frame - startFrame;

  // Ken Burns zoom effect on images
  const scale = clip.type === 'image'
    ? interpolate(localFrame, [0, durationFrames], [1.0, 1.08], {
        extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        easing: Easing.linear,
      })
    : 1.0;

  if (clip.type === 'image') {
    return (
      <Sequence from={startFrame} durationInFrames={durationFrames}>
        <AbsoluteFill>
          <Img
            src={clip.src}
            style={{
              width: '100%', height: '100%',
              objectFit: 'cover',
              transform: `scale(${scale})`,
              transformOrigin: 'center center',
            }}
          />
        </AbsoluteFill>
      </Sequence>
    );
  }

  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <AbsoluteFill>
        <Video
          src={clip.src}
          startFrom={Math.round((clip.trimStart || 0) * 30)}
          endAt={Math.round((clip.trimStart || 0) * 30) + durationFrames}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          volume={0}
        />
      </AbsoluteFill>
    </Sequence>
  );
};

// ── MAIN COMPOSITION ──
export const VideoComposition = ({
  clips = [],
  textOverlays = [],
  musicTrack = 'dark',
  musicStartTime = 0,
  bgColor = '#080808',
}) => {
  const { fps, durationInFrames } = useVideoConfig();

  // Calculate clip start frames
  let frameAccum = 0;
  const clipFrames = clips.map((clip) => {
    const startFrame = frameAccum;
    const durationFrames = Math.round(clip.duration * fps);
    frameAccum += durationFrames;
    return { clip, startFrame, durationFrames };
  });

  // Music tracks — using static files
  const musicMap = {
    dark: staticFile('music/dark_cinematic.mp3'),
    hard: staticFile('music/hard_beat.mp3'),
    luxury: staticFile('music/dark_luxury.mp3'),
  };
  const musicSrc = musicMap[musicTrack] || musicMap.dark;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, fontFamily: 'Bebas Neue, sans-serif' }}>

      {/* Background */}
      <AbsoluteFill style={{ backgroundColor: bgColor }} />

      {/* Video/Image clips */}
      {clipFrames.map(({ clip, startFrame, durationFrames }, i) => (
        <ClipSegment
          key={i}
          clip={clip}
          startFrame={startFrame}
          durationFrames={durationFrames}
          transition="flash"
        />
      ))}

      {/* Flash transitions between clips */}
      {clipFrames.slice(1).map(({ startFrame }, i) => (
        <FlashTransition key={`flash-${i}`} atFrame={startFrame} />
      ))}

      {/* Text overlays */}
      {textOverlays.map((overlay, i) => {
        const startFrame = Math.round(overlay.startTime * fps);
        const durationFrames = Math.round(overlay.duration * fps);
        return (
          <Sequence key={`text-${i}`} from={startFrame} durationInFrames={durationFrames}>
            <TextOverlay
              text={overlay.text}
              style={overlay.style || 'filled'}
              position={overlay.position || 'center'}
              startFrame={0}
              durationFrames={durationFrames}
            />
          </Sequence>
        );
      })}

      {/* UI elements */}
      <AccentLine />
      <Watermark />

      {/* Music */}
      {musicSrc && (
        <Audio
          src={musicSrc}
          startFrom={Math.round(musicStartTime * fps)}
          volume={0.85}
        />
      )}

    </AbsoluteFill>
  );
};
