// 路線圖用到的 React 與 React Flow API，打包成單一 ES module 給瀏覽器直接載入。
import * as React from 'react';
import { createRoot } from 'react-dom/client';

export { React, createRoot };
export {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  ViewportPortal,
  applyNodeChanges,
} from '@xyflow/react';
