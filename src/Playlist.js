'use strict';

import _ from 'lodash';

import h from 'virtual-dom/h';
import diff from 'virtual-dom/diff';
import patch from 'virtual-dom/patch';
import createElement from 'virtual-dom/create-element';

import {pixelsToSeconds} from './utils/conversions'
import extractPeaks from './utils/peaks';
import LoaderFactory from './track/loader/LoaderFactory';

import ScrollHook from './render/ScrollHook';

import Track from './Track';
import Playout from './Playout';

export default class {

    constructor() {

        this.tracks = [];
        this.soloedTracks = [];
        this.mutedTracks = [];
        this.playoutPromises = [];

        this.cursor = 0;
        this.playbackSeconds = 0;
        this.duration = 0;
        this.scrollLeft = 0;
    }

    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
    }

    setSamplesPerPixel(samplesPerPixel) {
        this.samplesPerPixel = samplesPerPixel;
    }

    setAudioContext(ac) {
        this.ac = ac;
    }

    setContainer(container) {
        this.container = container;
    }

    setControlOptions(controlOptions) {
        this.controls = controlOptions;
    }

    setWaveHeight(height) {
        this.waveHeight = height;
    }

    setColors(colors) {
        this.colors = colors;
    }

    setEventEmitter(ee) {
        this.ee = ee;
    }

    setIsMono(isMono) {
        this.mono = isMono;
    }

    isMono() {
        return this.mono;
    }

    getEventEmitter() {
        return this.ee;
    }

    setUpEventEmitter() {
        let ee = this.ee;

        ee.on('select', (start, end, track) => {

            if (this.isPlaying()) {
                this.lastSeeked = start;
                this.pausedAt = undefined;
                this.restartPlayFrom(start);
            }
            else {
                //reset if it was paused.
                this.playbackSeconds = 0;
                this.setTimeSelection(start, end);
                this.setActiveTrack(track);
                this.draw(this.render());
            }
        });

        ee.on('play', () => {
            this.play();
        });

        ee.on('pause', () => {
            this.pause();
        });

        ee.on('stop', () => {
            this.stop();
        });

        ee.on('rewind', () => {
            this.rewind();
        });

        ee.on('fastforward', () => {
            this.fastForward();
        });

        ee.on('solo', (track) => {
            this.soloTrack(track);
            this.adjustTrackPlayout();
            this.draw(this.render());
        });

        ee.on('mute', (track) => {
            this.muteTrack(track);
            this.adjustTrackPlayout();
            this.draw(this.render());
        });

        ee.on('volumechange', (volume, track) => {
            track.setGainLevel(volume/100);
        });
    }

    load(trackList, options={}) {
        let loadPromises = trackList.map((trackInfo) => {
            let loader = LoaderFactory.createLoader(trackInfo.src, this.ac);
            return loader.load();
        });

        return Promise.all(loadPromises).then((audioBuffers) => {
            let tracks = audioBuffers.map((audioBuffer, index) => {
                let name = trackList[index].name;

                //extract peaks with AudioContext for now.
                let peaks = extractPeaks(audioBuffer, this.samplesPerPixel, this.isMono());
                //webaudio specific playout for now.
                let playout = new Playout(this.ac, audioBuffer);

                let track = new Track();
                track.setName(name);
                track.setEventEmitter(this.ee);
                track.setEnabledStates();
                track.setPeaks(peaks);
                track.setCues(0, audioBuffer.duration);
                track.setFades();
                track.setStartTime(0);
                track.setPlayout(playout);

                this.duration = Math.max(this.duration, track.getEndTime());

                return track;
            });

            this.tracks = tracks;

            return tracks;

        }).then((trackEditors) => {

            this.setState(this.getState());

            //take care of virtual dom rendering.
            let tree = this.render();
            let rootNode = createElement(tree);

            this.container.appendChild(rootNode);
            this.tree = tree;
            this.rootNode = rootNode;

            return trackEditors;
        });
    }

    /*
        track instance of Track.
    */
    setActiveTrack(track) {
        this.activeTrack = track;
    }

    getActiveTrack() {
        return this.activeTrack;
    }

    /*
        start, end in seconds.
    */
    setTimeSelection(start, end) {
        this.timeSelection = {
            start,
            end,
        };

        this.cursor = start;
    }

    getTimeSelection() {
        return this.timeSelection;
    }

    setState(state) {
        this.state = state;

        this.tracks.forEach((editor) => {
            editor.setState(state);
        });
    }

    getState() {
        return this.state;
    }

    muteTrack(track) {
        let mutedList = this.mutedTracks;
        let index = mutedList.indexOf(track);

        if (index > -1) {
            mutedList.splice(index, 1);
        }
        else {
            mutedList.push(track);
        }
    }

    soloTrack(track) {
        let soloedList = this.soloedTracks;
        let index = soloedList.indexOf(track);

        if (index > -1) {
            soloedList.splice(index, 1);
        }
        else {
            soloedList.push(track);
        }
    }

    adjustTrackPlayout() {
        var masterGain;

        this.tracks.forEach((track) => {
            masterGain = this.shouldTrackPlay(track) ? 1 : 0;
            track.setMasterGainLevel(masterGain);
        });
    }

    shouldTrackPlay(track) {
        var shouldPlay;
        //if there are solo tracks, only they should play.
        if (this.soloedTracks.length > 0) {
            shouldPlay = false;
            if (this.soloedTracks.indexOf(track) > -1) {
                shouldPlay = true;
            }
        }
        //play all tracks except any muted tracks.
        else {
            shouldPlay = true;
            if (this.mutedTracks.indexOf(track) > -1) {
                shouldPlay = false;
            }
        }

        return shouldPlay;
    }

    isPlaying() {
        return this.tracks.reduce((isPlaying, track) => {
            return isPlaying || track.isPlaying();
        }, false);
    }

    /*
    *   returns the current point of time in the playlist in seconds.
    */
    getCurrentTime() {
        let cursorPos = this.lastSeeked || this.pausedAt || this.cursor;

        return cursorPos + this.getElapsedTime();
    }

    getElapsedTime() {
        let currentTime = this.ac.currentTime;

        return currentTime - this.lastPlay;
    }

    restartPlayFrom(cursorPos) {
        this.stopAnimation();

        this.tracks.forEach((editor) => {
            editor.scheduleStop();
        });

        Promise.all(this.playoutPromises).then(this.play.bind(this, cursorPos));
    }

    play(startTime) {
        var currentTime = this.ac.currentTime,
            endTime,
            selected = this.getTimeSelection(),
            playoutPromises = [];

        startTime = startTime || this.pausedAt || this.cursor;

        if (selected.endTime > startTime) {
            endTime = selected.endTime;
        }

        this.setState('cursor');

        this.tracks.forEach((editor) => {
            playoutPromises.push(editor.schedulePlay(currentTime, startTime, endTime, {
                masterGain: this.shouldTrackPlay(editor) ? 1 : 0
            }));
        });

        this.lastPlay = currentTime;
        //use these to track when the playlist has fully stopped.
        this.playoutPromises = playoutPromises;
        this.startAnimation(startTime);
    }

    pause() {
        if (!this.isPlaying()) {
            return;
        }

        this.pausedAt = this.getCurrentTime();
        this.playbackReset();
    }

    stop() {
        this.pausedAt = undefined;
        this.playbackSeconds = 0;
        this.playbackReset();
    }

    playbackReset() {
        this.lastSeeked = undefined;
        this.stopAnimation();

        this.tracks.forEach((editor) => {
            editor.scheduleStop();
        });

        this.setState(this.getState());
        this.draw(this.render());
    }

    rewind() {
        this.stop();

        Promise.all(this.playoutPromises).then(() => {
            this.scrollLeft = 0;
            this.ee.emit('select', 0, 0);
        });
    }

    fastForward() {
        this.stop();

        Promise.all(this.playoutPromises).then(() => {
            this.scrollLeft = this.duration;
            this.ee.emit('select', this.duration, this.duration);
        });
    }

    startAnimation(startTime) {
        this.lastDraw = this.ac.currentTime;
        this.animationRequest = window.requestAnimationFrame(this.updateEditor.bind(this, startTime));
    }

    stopAnimation() {
        window.cancelAnimationFrame(this.animationRequest);
        this.lastDraw = undefined;
    }

    /*
    * Animation function for the playlist.
    */
    updateEditor(cursorPos) {
        let currentTime = this.ac.currentTime;
        let playbackSeconds = 0;
        let elapsed;

        cursorPos = cursorPos || this.cursor;
        elapsed = currentTime - this.lastDraw;

        if (this.isPlaying()) {
            playbackSeconds = cursorPos + elapsed;

            this.animationRequest = window.requestAnimationFrame(this.updateEditor.bind(this, playbackSeconds));
        }
        else {
            this.stopAnimation();
            this.pausedAt = undefined;
            this.lastSeeked = undefined;
            this.setState(this.getState());
        }

        this.playbackSeconds = playbackSeconds;

        this.draw(this.render());
        this.lastDraw = currentTime;
    }

    draw(newTree) {
        let patches = diff(this.tree, newTree);
        
        window.requestAnimationFrame(() => {
            this.rootNode = patch(this.rootNode, patches);
            this.tree = newTree;
        });
    }

    getTrackRenderData(data={}) {
        let defaults = {
            "height": this.waveHeight,
            "resolution": this.samplesPerPixel,
            "sampleRate": this.sampleRate,
            "controls": this.controls,
            "isActive": false,
            "timeSelection": this.getTimeSelection(),
            "playlistLength": this.duration,
            "playbackSeconds": this.playbackSeconds,
            "colors": this.colors
        };

        return _.defaults(data, defaults);
    }

    render() {
        var activeTrack = this.getActiveTrack();

        let trackElements = this.tracks.map((track) => {
            return track.render(this.getTrackRenderData({
                "isActive": (activeTrack === track) ? true : false,
                "masterGain": this.shouldTrackPlay(track) ? 1 : 0,
                "soloed": this.soloedTracks.indexOf(track) > -1,
                "muted": this.mutedTracks.indexOf(track) > -1
            }));
        });

        return h("div.playlist", {
            "attributes": {
                "style": "overflow: hidden; position: relative;"
            }}, [
            h("div.playlist-tracks", {
                "attributes": {
                    "style": "overflow: auto;"
                },
                "ev-scroll": _.throttle((e) => {
                    this.scrollLeft = pixelsToSeconds(e.target.scrollLeft, this.samplesPerPixel, this.sampleRate);
                }, 200),
                "hook": new ScrollHook(this, this.samplesPerPixel, this.sampleRate)
            }, trackElements)
        ]);
    }  
}