#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>
#include "bm/ldraw/parse.h"
#include "bm/ldraw/part_cache.h"
#include "bm/model.h"
using namespace bm;
using Clock = std::chrono::steady_clock;

template <class T>
void mix(uint64_t& h, const std::vector<T>& v) {
  for (const T& x : v) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(&x);
    for (size_t i=0; i<sizeof(T); i++) h=(h^p[i])*1099511628211ull;
  }
}

int main(int argc, char** argv) {
  if (argc!=4) { std::cerr << "usage: inline_mesh_bench <mpd> <fixture-lib> <repetitions>\n"; return 2; }
  std::ifstream f(argv[1], std::ios::binary);
  std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  if (text.empty()) { std::cerr << "cannot load MPD\n"; return 2; }
  auto parsed=ldraw::parseMpd(text, std::filesystem::path(argv[1]).filename().string());
  ldraw::Library base(argv[2]);
  Model::Data data{{},{},{}, base.withInline(parsed), {}};
  std::vector<std::string> names;
  for (const auto& part:parsed)
    if (part.name.size()>=4 && part.name.substr(part.name.size()-4)==".dat") names.push_back(part.name);
  std::sort(names.begin(), names.end());
  names.erase(std::unique(names.begin(),names.end()),names.end());
  Model model(std::move(data));
  ldraw::PartCache cache(base, std::filesystem::temp_directory_path()/"brickmotion-inlinebench-cache");
  const auto t0=Clock::now();
  uint64_t fingerprint=1469598103934665603ull;
  size_t triangles=0, missing=0;
  for (const std::string& part:names) {
    const auto mesh=model.mesh(part,cache);
    triangles+=mesh->triangles.size()/3; missing+=mesh->missing.size();
    mix(fingerprint,mesh->positions); mix(fingerprint,mesh->triangles); mix(fingerprint,mesh->triColor);
  }
  const auto t1=Clock::now();
  std::shared_ptr<const ldraw::Mesh> first; bool stable=true;
  int rounds=std::stoi(argv[3]);
  const auto t2=Clock::now();
  for (int k=0;k<rounds;k++)
    for (const std::string& part:names) {
      const auto mesh=model.mesh(part,cache);
      if (part==names.front()) {
        if (!first) first=mesh;
        else stable &= mesh.get()==first.get();
      }
      triangles+=mesh->triangles.size()/3;
    }
  const auto t3=Clock::now();
  std::cout<<"inline_parts="<<names.size()<<" hash="<<fingerprint<<" missing_deps="<<missing
    <<" first_build_ms="<<std::chrono::duration<double,std::milli>(t1-t0).count()
    <<" repeat_ms="<<std::chrono::duration<double,std::milli>(t3-t2).count()
    <<" rounds="<<rounds<<" stable_pointer="<<stable<<" visited_triangles="<<triangles<<"\n";
  return 0;
}
