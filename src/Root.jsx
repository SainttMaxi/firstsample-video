import { Composition } from 'remotion';
import { VideoComposition } from './compositions/VideoComposition';

export const Root = () => {
  return (
    <Composition
      id="FirstSampleVideo"
      component={VideoComposition}
      durationInFrames={900}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        clips: [],
        textOverlays: [],
        musicTrack: 'dark',
        musicStartTime: 0,
        bgColor: '#080808',
      }}
    />
  );
};
