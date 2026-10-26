import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // Three.js and the add-ons the 3D table uses, pre-bundled together: found
  // one at a time (the table loads lazily), they'd end up as two copies.
  optimizeDeps: {
    include: [
      'three',
      'three/examples/jsm/geometries/RoundedBoxGeometry.js',
      'three/examples/jsm/environments/RoomEnvironment.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/FBXLoader.js',
    ],
  },
});
