# Hub 启动 Hermes ACP 的入口（Windows 修正）。
# Hermes 在 ACP 模式下由后台线程一直阻塞读标准输入（与 Hub 通信的管道）。Windows 上同步管道的读写会排队，
# 它起的 Git Bash 等子进程继承了这条管道，一碰标准输入就卡住，终端工具因此永远不返回（2026-11-28 本机复现）。
# 这里先把管道复制成一个不继承的句柄留给 ACP 自己读，再把标准输入换成 NUL，子进程就拿到 NUL。
import os
import sys

if os.name == 'nt':
    pipe_fd = os.dup(0)              # 新句柄默认不继承
    null_fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_fd, 0)              # fd 0 和进程标准输入句柄都换成 NUL
    os.close(null_fd)
    sys.stdin = open(pipe_fd, 'r', encoding='utf-8', newline='', closefd=True)
    # 输出管道同理：留一个不继承的句柄给 ACP 写，fd 1 换成 NUL，免得终端里起的后台进程拿着它写乱协议或拖住关闭（审查 P2-5）。
    out_fd = os.dup(1)
    null_w = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null_w, 1)
    os.close(null_w)
    sys.stdout = open(out_fd, 'w', encoding='utf-8', newline='', closefd=True)

import runpy
runpy.run_module('acp_adapter', run_name='__main__', alter_sys=True)
