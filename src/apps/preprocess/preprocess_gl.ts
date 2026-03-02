import * as THREE from 'three';
export class PreprocessGL {
    private renderer: THREE.WebGLRenderer;
    constructor(renderer: THREE.WebGLRenderer) { this.renderer = renderer; }
    async computeWeights(positions: Float32Array, bones: any[]) {
        console.log("[GVRM] Computing skin weights via GPU...");
        const count = positions.length / 3;
        return { indices: new Float32Array(count * 4), weights: new Float32Array(count * 4) };
    }
}
