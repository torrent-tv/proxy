set pagination off
set confirm off
set $base = (unsigned long) &system_base_info
set $hash = *(unsigned long *)($base + 0)
set $mask = *(unsigned long *)($base + 8)
printf "asochash=%p mask=%lu\n", $hash, $mask
set $i = 0
set $stcb = 0
if $hash != 0
  while $i <= $mask && $stcb == 0
    set $head = *(unsigned long *)($hash + $i * 8)
    if $head != 0
      set $stcb = $head
      printf "bucket %lu -> stcb=%p\n", $i, $stcb
    end
    set $i = $i + 1
  end
end
if $stcb == 0
  printf "no association found (no viewer connected?)\n"
else
  set $sock = *(unsigned long *)($stcb + 0)
  printf "socket=%p asoc=%p\n", $sock, $stcb + 88
  set $buf = (unsigned long) malloc(512)
  set $lenp = (unsigned long) malloc(8)
  set *(int *)$lenp = 512
  set $rc = (int) usrsctp_getsockopt($sock, 132, 256, $buf, $lenp)
  printf "getsockopt rc=%d len=%d\n", $rc, *(int *)$lenp
  printf "state=%d rwnd=%u unackdata=%u penddata=%u instrms=%u outstrms=%u fragpoint=%u\n", *(int *)($buf+4), *(unsigned int *)($buf+8), *(unsigned short *)($buf+12), *(unsigned short *)($buf+14), *(unsigned short *)($buf+16), *(unsigned short *)($buf+18), *(unsigned int *)($buf+20)
  printf "primary: state=%d cwnd=%u srtt=%u rto=%u mtu=%u\n", *(int *)($buf+24+4+128), *(unsigned int *)($buf+24+4+128+4), *(unsigned int *)($buf+24+4+128+8), *(unsigned int *)($buf+24+4+128+12), *(unsigned int *)($buf+24+4+128+16)
end
