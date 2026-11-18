// Standalone random equivalence check and synthetic benchmark for the sequencer's
// reverse blocker-dependency index. The benchmark models only invalidation cost.
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <numeric>
#include <random>
#include <vector>
#include "../../core/src/plan/blocker_index.h"

using bm::plan::BlockerIndex;
struct Attempt { bool ok = false; std::vector<uint32_t> stoppedBy; };

int main() {
  std::mt19937 mt(1234567);
  constexpr uint32_t n=341;
  std::vector<Attempt> attempts(n);
  std::vector<uint8_t> present(n,1), dirtyOld(n), dirtyNew(n);
  BlockerIndex index(n);
  for (size_t step=0; step<25000; step++) {
    uint32_t q=mt()%n;
    if (present[q] && (mt()%3)!=0) {
      attempts[q].ok=(mt()%5)==0;
      attempts[q].stoppedBy.clear();
      for (uint32_t c=0,k=mt()%25;c<k;c++) attempts[q].stoppedBy.push_back(mt()%n);
      index.updated(q,attempts[q].stoppedBy,attempts[q].ok);
    } else if (step%60==0) {
      std::vector<uint32_t> removed;
      for (uint32_t i=0;i<2;i++) {
        q=mt()%n;
        if (present[q]) removed.push_back(q),present[q]=0;
      }
      std::sort(removed.begin(),removed.end());
      removed.erase(std::unique(removed.begin(),removed.end()),removed.end());
      for (uint32_t p=0;p<n;p++)
        if (present[p] && !attempts[p].ok)
          for (uint32_t stop:attempts[p].stoppedBy)
            if (std::binary_search(removed.begin(),removed.end(),stop)) {dirtyOld[p]=2;break;}
      for (uint32_t stop:removed)
        index.blockerRemoved(stop,[&](uint32_t affected) {
          if(present[affected] && !attempts[affected].ok) dirtyNew[affected]=2;
        });
      if(dirtyOld!=dirtyNew) {
        std::cerr<<"mismatch at step "<<step<<"\n";
        return 1;
      }
    }
  }
  std::cout<<"randomized_equivalence=PASS events=25000\n";
  // Exactly the old O(N) scan versus the index on N=2,119 blocked pieces.
  constexpr uint32_t m=2119;
  std::vector<Attempt> a(m);
  std::vector<uint8_t> alive(m,1), o(m), t(m);
  BlockerIndex fast(m);
  for(uint32_t p=0;p<m;p++) {
    for(uint32_t i=0;i<4;i++) a[p].stoppedBy.push_back((p*991u+i*313u+17u)%m);
    fast.updated(p,a[p].stoppedBy,false);
  }
  const auto beg=std::chrono::steady_clock::now();
  for(uint32_t p=0;p<m;p++) {
    alive[p]=0;
    for(uint32_t q=0;q<m;q++)
      if(alive[q] && !a[q].ok)
        for(uint32_t b:a[q].stoppedBy)
          if(b==p) {o[q]=2;break;}
  }
  const auto mid=std::chrono::steady_clock::now();
  std::fill(alive.begin(),alive.end(),1);
  for(uint32_t p=0;p<m;p++) {
    alive[p]=0;
    fast.blockerRemoved(p,[&](uint32_t q){if(alive[q]&&!a[q].ok)t[q]=2;});
  }
  const auto end=std::chrono::steady_clock::now();
  assert(o==t);
  if(o!=t) { std::cerr<<"benchmark equivalence FAILED\n";return 1; }
  std::cout<<"synthetic_invalidations="<<m<<" blockers_per_attempt=4 old_ms="
   <<std::chrono::duration<double,std::milli>(mid-beg).count()<<" index_ms="
   <<std::chrono::duration<double,std::milli>(end-mid).count()<<" equivalent=PASS\n";
}
