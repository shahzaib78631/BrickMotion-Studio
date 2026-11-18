import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup

import find_bricksafe_models as finder


class RandomPagesTests(unittest.TestCase):
    def test_only_random_grid_supplies_candidates(self):
        soup = BeautifulSoup('''
          <div class="content"><div class="headline"><h2>Popular Pages</h2></div>
            <div class="cube-portfolio"><a href="/pages/popular/">Popular</a></div></div>
          <div class="content"><div class="headline"><h2>Random Pages</h2></div>
            <div class="cube-portfolio">
              <a href="/pages/random/folder/">Random</a>
              <img data-src="/cache/other/folder/photo.jpg/250x250.jpg">
              <a href="https://example.com/pages/external/">External</a>
            </div></div>
          <footer><a href="/pages/footer/">Footer</a></footer>
        ''', "html.parser")
        self.assertEqual(finder.find_browse_pages(soup), {
            finder.BASE + "/pages/random/folder/",
            finder.BASE + "/pages/other/folder/",
        })

    def test_missing_random_section_fails_instead_of_using_popular(self):
        with self.assertRaisesRegex(ValueError, "Random Pages"):
            finder.find_browse_pages(BeautifulSoup('<a href="/pages/popular/">Popular</a>', "html.parser"))

    def test_each_sample_has_a_distinct_request_url(self):
        with patch.object(finder, "fetch") as fetch, patch.object(finder, "find_browse_pages", return_value=set()):
            session = object()
            finder.fetch_random_pages(session)
            finder.fetch_random_pages(session)
        first, second = [call.args for call in fetch.call_args_list]
        self.assertIs(first[0], session)
        self.assertTrue(first[1].startswith(finder.BASE + "/browse?sample="))
        self.assertNotEqual(first[1], second[1])


if __name__ == "__main__":
    unittest.main()
