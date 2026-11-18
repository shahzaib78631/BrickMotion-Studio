#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include "bm/ldraw/parse.h"
#include "bm/model.h"
#include "bm/collide/world.h"
using namespace bm;
using Clock = std::chrono::steady_clock;

template <class T> void mix(uint64_t& h, const std::vector<T>& v) {
 for (const T& x : v) {
  const uint8_t* p=reinterpret_cast<const uint8_t*>(&x);
  for (size_t i=0;i<sizeof(T);++i) h=(h ^ p[i])*1099511628211ull;
 }
}

int main(int argc,char** argv) {
 if (argc!=4) { std::cerr<<"usage <mpd> <lib> <rounds>\n"; return 2; }
 std::ifstream f(argv[1],std::ios::binary);
 std::string text((std::istreambuf_iterator<char>(f)),std::istreambuf_iterator<char>());
 ldraw::Library lib(argv[2]);
 auto files=ldraw::parseMpd(text, std::filesystem::path(argv[1]).filename().string());
 Model::Data data{{},{},{},lib.withInline(files),{}};
 std::vector<std::string> names;
 for (const auto& file:files)
   if (file.name.size()>=4 && file.name.substr(file.name.size()-4)==".dat") names.push_back(file.name);
 std::sort(names.begin(),names.end());
 names.erase(std::unique(names.begin(),names.end()),names.end());
 for (size_t i=0;i<names.size();i++) {
   Piece p;
   p.id=std::to_string(i);p.part=names[i];p.world.t={static_cast<double>(i)*10000.,0,0};
   data.pieces.push_back(p);
 }
 Model model(std::move(data));
 ldraw::PartCache parts(lib,std::filesystem::temp_directory_path()/"brickmotion-worldbench-cache");
 collide::ShapeCache shapes;
 const auto t0=Clock::now();
 collide::World first(model,parts,shapes);
 const auto t1=Clock::now();
 uint64_t hash=1469598103934665603ull; size_t tr=0,node=0,nonempty=0;
 for (uint32_t p=0;p<model.pieces().size();p++) {
   const auto& shape=first.shape(p);
   tr+=shape.triangles.size()/3; node+=shape.nodes.size(); nonempty+=!shape.nodes.empty();
   mix(hash,shape.triangles);mix(hash,shape.outer);mix(hash,shape.inner);
   Box q=first.box(p);
   if (!q.empty()) {
     std::vector<uint32_t> candidates; first.near(q,nullptr,candidates);
     // Include observable broadphase results in fingerprint.
     mix(hash,candidates);
   }
 }
 const int repeats=std::stoi(argv[3]);
 const auto t2=Clock::now();
 for (int i=0;i<repeats;i++) {
   collide::World world(model,parts,shapes);
   if (world.size()!=model.pieces().size()) return 3;
 }
 const auto t3=Clock::now();
 std::cout<<"pieces="<<names.size()<<" nonempty="<<nonempty<<" tris="<<tr<<" nodes="<<node<<" fingerprint="<<hash
   <<" cold_world_ms="<<std::chrono::duration<double,std::milli>(t1-t0).count()
   <<" repeat_world_ms="<<std::chrono::duration<double,std::milli>(t3-t2).count()
   <<" rounds="<<repeats<<"\n";
 return 0;
}
