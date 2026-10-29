#!/usr/bin/python3
import socket,json,sys,struct
host=sys.argv[1];port=int(sys.argv[2])
def varint(n):
 b=b''
 while True:
  v=n&127;n>>=7;b+=bytes([v|(128 if n else 0)])
  if not n:return b
def exact(s,n):
 b=b''
 while len(b)<n:
  x=s.recv(n-len(b))
  if not x:raise EOFError()
  b+=x
 return b
def readint(s):
 n=0
 for i in range(5):
  b=exact(s,1)[0];n|=(b&127)<<(7*i)
  if b<128:return n
 raise ValueError('Invalid varint')
with socket.create_connection((host,port),10) as s:
 s.settimeout(10);h=host.encode();packet=b'\0'+varint(767)+varint(len(h))+h+struct.pack('>H',port)+b'\1'
 s.sendall(varint(len(packet))+packet+b'\1\0')
 readint(s);assert readint(s)==0
 data=json.loads(exact(s,readint(s)))
 print(json.dumps({'host':host,'port':port,'players':data.get('players'),'description':data.get('description')},ensure_ascii=False))
