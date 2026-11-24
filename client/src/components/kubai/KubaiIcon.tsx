import { useEffect, useRef, type HTMLAttributes } from 'react';
import { mountKubaiIcon } from './runtime.generated';
import './kubai.css';

interface KubaiIconProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  size?: number;
  strokeWidth?: number;
}

export function KubaiIcon({ name, size = 24, strokeWidth: _strokeWidth, className = '', ...props }: KubaiIconProps) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const instance = mountKubaiIcon(host.current, name);
    const target = host.current.closest('button,a,[role="button"]') || host.current;
    let pointer = false;
    let focused = false;
    const update = () => instance.hover(pointer || focused);
    const enter = () => { pointer = true; update(); };
    const leave = () => { pointer = false; update(); };
    const focus = () => { focused = true; update(); };
    const blur = () => { focused = false; update(); };
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    target.addEventListener('focusin', focus);
    target.addEventListener('focusout', blur);
    return () => {
      target.removeEventListener('pointerenter', enter);
      target.removeEventListener('pointerleave', leave);
      target.removeEventListener('focusin', focus);
      target.removeEventListener('focusout', blur);
      instance.destroy();
    };
  }, [name]);
  return <span {...props} ref={host} aria-hidden="true" className={`kubai-icon ${className}`} style={{ width: size, height: size, ...props.style }} />;
}

export type ProductIconName = '文件夹' | '文档' | '剪贴板' | '搜索' | '书本' | '图表' | '灯泡' | '时钟' | '盾牌' | '上传' | '同步' | '复制' | '回收站' | '编辑' | '照片' | '锁';
