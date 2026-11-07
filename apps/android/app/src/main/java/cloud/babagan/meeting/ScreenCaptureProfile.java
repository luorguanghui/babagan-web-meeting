package cloud.babagan.meeting;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Configured cadence; achieved frame rate remains a runtime WebRTC statistic. */
final class ScreenCaptureProfile {
    /** Pre-SDP parameters are optional hints. Once the answer is set, every failure is fatal. */
    static void applySenderConfiguration(boolean negotiated, Runnable configure) {
        try { configure.run(); }
        catch (RuntimeException error) { if (negotiated) throw error; }
    }

    static int frameRate(int requested) {
        if (requested != 30 && requested != 60) throw new IllegalArgumentException("Screen frame rate must be 30 or 60");
        return requested;
    }

    /** SDP's framerate is a maximum-rate hint, in addition to actual source/sender configuration. */
    static String withFrameRate(String sdp, int rate) {
        if (rate != 15) frameRate(rate); // 15 belongs only to the existing debug synthetic source.
        String ending = sdp.contains("\r\n") ? "\r\n" : "\n";
        List<String> lines = Arrays.asList(sdp.split("\\r?\\n", -1));
        List<String> output = new ArrayList<>();
        for (int index = 0; index < lines.size();) {
            if (!lines.get(index).startsWith("m=")) { output.add(lines.get(index++)); continue; }
            int start = index++;
            while (index < lines.size() && !lines.get(index).startsWith("m=")) index++;
            List<String> section = lines.subList(start, index);
            boolean video = section.get(0).matches("m=video\\s+(?!0(?:\\s|/))\\d+.*");
            if (!video) { output.addAll(section); continue; }
            int end = section.size();
            while (end > 0 && section.get(end - 1).isEmpty()) end--;
            for (int i = 0; i < end; i++) if (!section.get(i).startsWith("a=framerate:")) output.add(section.get(i));
            output.add("a=framerate:" + rate);
            output.addAll(section.subList(end, section.size()));
        }
        return String.join(ending, output);
    }
}
