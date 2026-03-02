import * as THREE from 'three';
export class SceneBuilder {
    static create() {
        const scene = new THREE.Scene();
        scene.add(new THREE.GridHelper(10, 10));
        return scene;
    }
}
